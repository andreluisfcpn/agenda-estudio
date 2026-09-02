// ─── Sicoob PIX API Service ─────────────────────────────
// Recebimento via PIX (padrão API Pix do Banco Central: /cob, txid, pixCopiaECola, /webhook).
// Docs: https://developers.sicoob.com.br/portal/apis
//
// Autenticação:
//   • sandbox    → client_id + access_token FIXOS públicos de teste (sem certificado, sem OAuth).
//   • production → OAuth2 client_credentials via mTLS (certificado ICP-Brasil e-CNPJ do estúdio).
//
// Usa node:https diretamente para suportar mTLS (o fetch/undici não suporta https.Agent).

import { prisma } from './prisma.js';
import https from 'https';
import { URL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import QRCode from 'qrcode';
import { decryptConfigSafe } from '../utils/crypto.js';

// ─── Types ───────────────────────────────────────────────

/** Credenciais de um ambiente (sandbox ou production). */
interface SicoobCredentials {
    clientId: string;
    /** PEM do certificado cliente (mTLS) — obrigatório só em produção. */
    certificatePem?: string;
    /** PEM da chave privada (mTLS) — obrigatório só em produção. */
    privateKeyPem?: string;
    /** Chave PIX do recebedor (estúdio) cadastrada na conta Sicoob. */
    pixKey: string;
    webhookSecret?: string;
}

interface SicoobConfigDual {
    sandbox?: SicoobCredentials;
    production?: SicoobCredentials;
}

interface SicoobToken {
    access_token: string;
    expires_in: number;
    token_type: string;
}

export interface SicoobPixPayload {
    amount: number;          // em centavos
    /** txid (26–35 alfanumérico). Estável por pagamento → idempotência/conciliação. */
    txid: string;
    description: string;     // vira solicitacaoPagador (máx 140 chars)
    customer: {
        name: string;
        document: { identity: string; type: 'CPF' | 'CNPJ' };
    };
    /** Segundos até expirar a cobrança (default 3600 = 1h). */
    expiresSeconds?: number;
}

export interface SicoobPixResult {
    /** txid da cobrança (usado como providerRef). */
    id: string;
    pixString: string;        // pixCopiaECola (EMV BRCode)
    qrCodeBase64?: string;    // gerado localmente a partir do EMV
    status: string;           // ATIVA | CONCLUIDA | REMOVIDA_*
}

// ─── Credenciais fixas de sandbox (públicas, fornecidas pelo Sicoob) ─
// No sandbox NÃO se usa certificado nem OAuth: envia-se este Bearer fixo e o client_id.
// NUNCA válidas em produção.
const SICOOB_SANDBOX_CLIENT_ID = '9b5e603e428cc477a2841e2683c92d21';
const SICOOB_SANDBOX_TOKEN = '1301865f-c6bc-38f3-9f49-666dbcfc59c3';

// ─── API URLs ────────────────────────────────────────────

const SICOOB_URLS = {
    sandbox: {
        auth: '', // sandbox não usa OAuth
        api: 'https://sandbox.sicoob.com.br/sicoob/sandbox/pix/api/v2',
    },
    production: {
        auth: 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token',
        api: 'https://api.sicoob.com.br/pix/api/v2',
    },
};

// Escopos necessários (criar/consultar cobrança imediata + gerenciar webhook + consultar pix).
const SICOOB_SCOPES = 'cob.read cob.write pix.read webhook.read webhook.write';

// ─── Token Cache ─────────────────────────────────────────

let _tokenCache: { token: string; expiresAt: number; environment: string } | null = null;

// ─── Config Parser ───────────────────────────────────────

function isDualConfig(parsed: any): parsed is SicoobConfigDual {
    return parsed && (typeof parsed.sandbox === 'object' || typeof parsed.production === 'object');
}

function fixNewlines(creds: SicoobCredentials): SicoobCredentials {
    if (creds.certificatePem) creds.certificatePem = creds.certificatePem.replace(/\\n/g, '\n');
    if (creds.privateKeyPem)  creds.privateKeyPem  = creds.privateKeyPem.replace(/\\n/g, '\n');
    return creds;
}

async function getSicoobConfig(): Promise<{ config: SicoobCredentials; environment: 'sandbox' | 'production' } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'SICOOB' } });
    if (!integration || !integration.enabled) return null;
    try {
        const decrypted = decryptConfigSafe(integration.config);
        const parsed = JSON.parse(decrypted);
        const environment = (integration.environment === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production';

        let credentials: SicoobCredentials | undefined;
        if (isDualConfig(parsed)) {
            credentials = parsed[environment];
        } else {
            // Formato flat legado → tratado como sandbox.
            credentials = parsed as SicoobCredentials;
        }

        // Sandbox: preenche client_id/pixKey de teste quando não informados, para permitir
        // testar sem cadastro real. Produção exige credenciais completas de verdade.
        if (environment === 'sandbox') {
            credentials = {
                clientId: credentials?.clientId || SICOOB_SANDBOX_CLIENT_ID,
                pixKey: credentials?.pixKey || 'sandbox-pix-key',
                certificatePem: credentials?.certificatePem,
                privateKeyPem: credentials?.privateKeyPem,
                webhookSecret: credentials?.webhookSecret,
            };
        }

        if (!credentials?.clientId) {
            console.warn(`[Sicoob] Sem credenciais para o ambiente "${environment}"`);
            return null;
        }

        return { config: fixNewlines(credentials), environment };
    } catch {
        return null;
    }
}

// ─── HTTP (node:https, mTLS opcional) ────────────────────

function httpsCall(
    url: string,
    options: { method: string; headers?: Record<string, string>; body?: string; cert?: string; key?: string }
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const reqOptions: https.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: options.method,
            headers: options.headers || {},
            rejectUnauthorized: true,
        };
        if (options.cert) reqOptions.cert = options.cert;
        if (options.key) reqOptions.key = options.key;
        if (options.body) {
            (reqOptions.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(options.body, 'utf-8').toString();
        }

        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode || 500, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => req.destroy(new Error('Request timeout (30s)')));
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ─── Auth ────────────────────────────────────────────────

/** Retorna { token, clientId, environment, config } prontos para chamar a API. */
async function sicoobAuth(): Promise<{ token: string; config: SicoobCredentials; environment: 'sandbox' | 'production'; api: string }> {
    const setup = await getSicoobConfig();
    if (!setup) throw new Error('Integração Sicoob não configurada ou desabilitada');
    const { config, environment } = setup;
    const urls = SICOOB_URLS[environment];

    // Sandbox: token público fixo, sem rede/OAuth/mTLS.
    if (environment === 'sandbox') {
        return { token: SICOOB_SANDBOX_TOKEN, config, environment, api: urls.api };
    }

    // Produção: OAuth2 client_credentials via mTLS.
    if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000 && _tokenCache.environment === environment) {
        return { token: _tokenCache.token, config, environment, api: urls.api };
    }
    if (!config.certificatePem || !config.privateKeyPem) {
        throw new Error('Certificado mTLS (cert + chave privada) é obrigatório em produção no Sicoob.');
    }

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        scope: SICOOB_SCOPES,
    }).toString();

    const response = await httpsCall(urls.auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });
    if (response.status >= 400) {
        throw new Error(`Sicoob auth falhou (${response.status}): ${response.body}`);
    }
    const data: SicoobToken = JSON.parse(response.body);
    _tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
        environment,
    };
    return { token: data.access_token, config, environment, api: urls.api };
}

/** Headers padrão do Sicoob: Bearer + client_id em toda chamada. */
function sicoobHeaders(token: string, clientId: string, json = true): Record<string, string> {
    const h: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'client_id': clientId,
        'Accept': 'application/json',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}

// ─── API pública ─────────────────────────────────────────

/** Cria uma cobrança PIX imediata (PUT /cob/{txid}) e retorna o copia-e-cola + QR. */
export async function sicoobCreatePix(payload: SicoobPixPayload): Promise<SicoobPixResult> {
    if (!Number.isInteger(payload.amount) || payload.amount <= 0) {
        throw new Error('Valor do pagamento inválido (deve ser maior que zero).');
    }
    if (!/^[a-zA-Z0-9]{26,35}$/.test(payload.txid)) {
        throw new Error(`txid inválido (precisa ser 26–35 alfanuméricos): ${payload.txid}`);
    }

    const { token, config, environment, api } = await sicoobAuth();

    const devedorKey = payload.customer.document.type === 'CNPJ' ? 'cnpj' : 'cpf';
    const body = JSON.stringify({
        calendario: { expiracao: payload.expiresSeconds ?? 3600 },
        devedor: {
            [devedorKey]: payload.customer.document.identity,
            nome: payload.customer.name,
        },
        valor: { original: (payload.amount / 100).toFixed(2) },
        chave: config.pixKey,
        solicitacaoPagador: payload.description.slice(0, 140),
    });

    if (process.env.NODE_ENV !== 'production') {
        console.log('[Sicoob PIX] PUT', `${api}/cob/${payload.txid}`, `(env=${environment})`);
    }

    const response = await httpsCall(`${api}/cob/${payload.txid}`, {
        method: 'PUT',
        headers: sicoobHeaders(token, config.clientId),
        body,
        cert: environment === 'production' ? config.certificatePem : undefined,
        key: environment === 'production' ? config.privateKeyPem : undefined,
    });

    if (process.env.NODE_ENV !== 'production') {
        console.log('[Sicoob PIX] status', response.status, 'body', response.body.slice(0, 200));
    }
    if (response.status >= 400) {
        throw new Error(`Sicoob criar cobrança falhou (${response.status}): ${response.body}`);
    }

    const result = JSON.parse(response.body);
    // BACen usa `pixCopiaECola`; o Sicoob (inclusive o sandbox mock) responde em `brcode`.
    const emv: string = result.pixCopiaECola || result.brcode || '';

    let qrCodeBase64: string | undefined;
    if (emv) {
        try {
            const dataUrl = await QRCode.toDataURL(emv, { width: 256, margin: 2 });
            qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        } catch (err) {
            console.error('[Sicoob PIX] Falha ao gerar QR do EMV:', err);
        }
    }

    return {
        // O recurso vive no txid que ENVIAMOS no PUT (o corpo do sandbox devolve um txid mock aleatório).
        id: payload.txid,
        pixString: emv,
        qrCodeBase64,
        status: result.status || 'ATIVA',
    };
}

/** Consulta uma cobrança (GET /cob/{txid}). Retorna o objeto cru da API. */
export async function sicoobGetCob(txid: string): Promise<any> {
    if (!/^[a-zA-Z0-9]{26,35}$/.test(txid)) {
        throw new Error('txid inválido');
    }
    const { token, config, environment, api } = await sicoobAuth();
    const response = await httpsCall(`${api}/cob/${txid}`, {
        method: 'GET',
        headers: sicoobHeaders(token, config.clientId, false),
        cert: environment === 'production' ? config.certificatePem : undefined,
        key: environment === 'production' ? config.privateKeyPem : undefined,
    });
    if (response.status >= 400) {
        throw new Error(`Sicoob consultar cobrança falhou (${response.status}): ${response.body}`);
    }
    return JSON.parse(response.body);
}

/** Registra a URL de webhook para a chave PIX (PUT /webhook/{chave}). */
export async function sicoobRegisterWebhook(webhookUrl: string): Promise<void> {
    const { token, config, environment, api } = await sicoobAuth();
    const response = await httpsCall(`${api}/webhook/${encodeURIComponent(config.pixKey)}`, {
        method: 'PUT',
        headers: sicoobHeaders(token, config.clientId),
        body: JSON.stringify({ webhookUrl }),
        cert: environment === 'production' ? config.certificatePem : undefined,
        key: environment === 'production' ? config.privateKeyPem : undefined,
    });
    if (response.status >= 400) {
        throw new Error(`Sicoob registrar webhook falhou (${response.status}): ${response.body}`);
    }
}

/** Consulta o webhook registrado para a chave PIX (GET /webhook/{chave}). */
export async function sicoobGetWebhook(): Promise<any> {
    const { token, config, environment, api } = await sicoobAuth();
    const response = await httpsCall(`${api}/webhook/${encodeURIComponent(config.pixKey)}`, {
        method: 'GET',
        headers: sicoobHeaders(token, config.clientId, false),
        cert: environment === 'production' ? config.certificatePem : undefined,
        key: environment === 'production' ? config.privateKeyPem : undefined,
    });
    if (response.status === 404) return null;
    if (response.status >= 400) {
        throw new Error(`Sicoob consultar webhook falhou (${response.status}): ${response.body}`);
    }
    return JSON.parse(response.body);
}

/** Remove o webhook da chave PIX (DELETE /webhook/{chave}). */
export async function sicoobDeleteWebhook(): Promise<void> {
    const { token, config, environment, api } = await sicoobAuth();
    const response = await httpsCall(`${api}/webhook/${encodeURIComponent(config.pixKey)}`, {
        method: 'DELETE',
        headers: sicoobHeaders(token, config.clientId, false),
        cert: environment === 'production' ? config.certificatePem : undefined,
        key: environment === 'production' ? config.privateKeyPem : undefined,
    });
    if (response.status >= 400 && response.status !== 404) {
        throw new Error(`Sicoob remover webhook falhou (${response.status}): ${response.body}`);
    }
}

// ─── Diagnóstico ─────────────────────────────────────────

function certSummary(pem?: string): string {
    if (!pem) return '';
    try {
        const x = new X509Certificate(pem.replace(/\\n/g, '\n'));
        const cn = (x.subject.match(/CN=([^\n]+)/) || [])[1]?.trim() || '?';
        const validTo = new Date(x.validTo);
        const expired = validTo.getTime() < Date.now();
        return ` [cert CN=${cn}, válido até ${validTo.toLocaleDateString('pt-BR')}${expired ? ' — EXPIRADO' : ''}]`;
    } catch { return ''; }
}

export async function sicoobTestConnection(): Promise<{ success: boolean; message: string }> {
    const setup = await getSicoobConfig();
    if (!setup) return { success: false, message: 'Integração Sicoob não configurada ou desabilitada.' };
    const certInfo = certSummary(setup.config.certificatePem);
    try {
        const { environment } = await sicoobAuth();
        if (environment === 'sandbox') {
            _tokenCache = null;
            return { success: true, message: 'Sicoob sandbox OK (token público de teste — sem certificado).' };
        }
        _tokenCache = null;
        return { success: true, message: `Autenticação Sicoob realizada com sucesso! (OAuth2 + mTLS OK, ambiente: ${environment})${certInfo}` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        if (msg.includes('certificate') || msg.includes('key') || msg.includes('SSL') || msg.includes('TLS') || msg.includes('EPROTO')) {
            return { success: false, message: `Erro no certificado mTLS: o Sicoob não aceitou o certificado/chave.${certInfo} Detalhe: ${msg}` };
        }
        if (msg.includes('invalid_client') || msg.includes('401') || msg.includes('403')) {
            return { success: false, message: `O Sicoob recusou a credencial (client_id x certificado precisam ser do mesmo aplicativo/titular).${certInfo} Detalhe: ${msg}` };
        }
        return { success: false, message: `Falha na autenticação Sicoob: ${msg}${certInfo}` };
    }
}

export async function isSicoobEnabled(): Promise<boolean> {
    const setup = await getSicoobConfig();
    return setup !== null;
}

/** Ambiente ativo do Sicoob (para o checkout saber se está em sandbox). */
export async function getSicoobEnvironment(): Promise<'sandbox' | 'production' | null> {
    const setup = await getSicoobConfig();
    return setup ? setup.environment : null;
}
