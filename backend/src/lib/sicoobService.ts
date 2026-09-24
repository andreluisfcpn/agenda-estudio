// ─── Sicoob PIX API Service ─────────────────────────────
// Recebimento via PIX (padrão API Pix do Banco Central: /cob, txid, pixCopiaECola, /webhook).
// Docs: https://developers.sicoob.com.br/portal/apis
//
// Autenticação:
//   • sandbox    → client_id + access_token de teste (sem certificado, sem OAuth). Por padrão os
//                  PÚBLICOS embutidos; o admin pode salvar os próprios pelo painel (fallback p/ os
//                  públicos). Base sandbox (mock, cópia de produção): dev/homologação.
//   • production → OAuth2 client_credentials via mTLS (certificado ICP-Brasil e-CNPJ do estúdio).
//                  Base real (api.sicoob.com.br): a API "de verdade", usada só em produção.
//
// TRAVA POR DEPLOY (segurança financeira): o ambiente permitido é decidido pelo NODE_ENV do
// servidor, não só pelo toggle do painel — deploy de produção só opera em `production`; qualquer
// outro deploy (development/homologação) só opera em `sandbox`. Assim é impossível cobrar de
// verdade fora de produção ou rodar mock em produção, mesmo que o toggle do banco esteja errado
// (ex.: banco de produção clonado para homologação). Ver `sicoobAllowedEnvironment()`.
//
// Usa node:https diretamente para suportar mTLS (o fetch/undici não suporta https.Agent).

import { prisma } from './prisma.js';
import https from 'https';
import { URL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import QRCode from 'qrcode';
import { decryptConfigSafe } from '../utils/crypto.js';
import { isValidBrCode, buildStaticBrCode, brCodeAmountCents } from './brcode.js';

// ─── Types ───────────────────────────────────────────────

/** Credenciais de um ambiente (sandbox ou production). */
interface SicoobCredentials {
    clientId: string;
    /**
     * Access token (Bearer) FIXO — só usado no sandbox. Opcional: se vazio, cai no token público
     * de teste embutido (SICOOB_SANDBOX_TOKEN). Serve para o admin trocar o par client_id+token de
     * teste pelo painel (ex.: se o Sicoob rotacionar o público) sem precisar mexer no código.
     * Em produção é ignorado — lá o token vem do OAuth via mTLS.
     */
    accessToken?: string;
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
    pixString: string;        // pixCopiaECola (EMV BRCode) — sempre um BR Code válido
    qrCodeBase64?: string;    // gerado localmente a partir do EMV
    status: string;           // ATIVA | CONCLUIDA | REMOVIDA_*
    /** Fim da validade da cobrança (criação + calendario.expiracao). */
    expiresAt: Date;
    /** true quando o EMV é o BR Code SINTÉTICO de sandbox/dev (nunca em produção). */
    synthetic?: boolean;
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

// ─── Trava de ambiente por deploy ────────────────────────

/**
 * Único ambiente Sicoob que ESTE deploy pode operar (decidido pelo servidor, não pelo painel):
 *   • NODE_ENV === 'production' → 'production' (a API real, com mTLS).
 *   • qualquer outro valor      → 'sandbox'   (mock público — desenvolvimento/homologação).
 * É a fonte de verdade da trava financeira: nunca cobrar de verdade fora de produção nem rodar
 * mock em produção. Usada no runtime (getSicoobConfig / roteamento) e na UI/validação do painel.
 */
export function sicoobAllowedEnvironment(): 'sandbox' | 'production' {
    return process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
}

const sicoobEnvLabel = (env: string) => (env === 'production' ? 'produção' : 'sandbox');

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

/**
 * Normaliza a chave PIX para o formato que a API Pix (Bacen) exige. Chaves de CPF/CNPJ precisam ir
 * SÓ com os dígitos — se o admin cadastrou com pontuação (ex.: CNPJ "12.345.678/0001-90"), o Sicoob
 * rejeita a cobrança por schema. Para evitar qualquer risco de quebrar outros tipos, só agimos quando
 * a chave casa EXATAMENTE a máscara de CPF ou CNPJ; e-mail, telefone, chave aleatória e uma chave já
 * só-dígitos passam intactas.
 */
const CPF_MASK = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;
const CNPJ_MASK = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
export function normalizePixKey(raw: string | undefined | null): string {
    const key = (raw ?? '').trim();
    if (CPF_MASK.test(key) || CNPJ_MASK.test(key)) return key.replace(/\D/g, '');
    return key;
}

async function getSicoobConfig(): Promise<{ config: SicoobCredentials; environment: 'sandbox' | 'production' } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'SICOOB' } });
    if (!integration || !integration.enabled) return null;
    try {
        const decrypted = decryptConfigSafe(integration.config);
        const parsed = JSON.parse(decrypted);
        const environment = (integration.environment === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production';

        // Trava por deploy: se o ambiente ativo no painel não é o permitido por este servidor
        // (NODE_ENV), bloqueia — fail-closed. Nunca cobra de verdade fora de produção nem roda
        // mock em produção, mesmo com o toggle do banco errado. O admin corrige o ambiente ativo.
        const allowedEnv = sicoobAllowedEnvironment();
        if (environment !== allowedEnv) {
            console.warn(`[Sicoob] Ambiente ativo "${environment}" bloqueado neste deploy (NODE_ENV=${process.env.NODE_ENV || 'development'} → apenas "${allowedEnv}"). Ajuste o ambiente ativo no painel.`);
            return null;
        }

        let credentials: SicoobCredentials | undefined;
        if (isDualConfig(parsed)) {
            credentials = parsed[environment];
        } else {
            // Formato flat legado → tratado como sandbox.
            credentials = parsed as SicoobCredentials;
        }

        // Sandbox: preenche client_id/token/pixKey de teste quando não informados, para permitir
        // testar sem cadastro real. O admin pode salvar client_id + accessToken próprios (o painel
        // os grava) — usados no lugar dos públicos. Produção exige credenciais completas de verdade.
        if (environment === 'sandbox') {
            credentials = {
                clientId: credentials?.clientId || SICOOB_SANDBOX_CLIENT_ID,
                accessToken: credentials?.accessToken || SICOOB_SANDBOX_TOKEN,
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

        const normalizedConfig = fixNewlines(credentials);
        // Chave de CPF/CNPJ cadastrada com pontuação vira só-dígitos (formato exigido pela API Pix).
        normalizedConfig.pixKey = normalizePixKey(normalizedConfig.pixKey);
        return { config: normalizedConfig, environment };
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
            // Hardening: uma resposta cortada no meio (conexão resetada, proxy caindo) emite 'error'/
            // 'aborted' no STREAM DA RESPOSTA — sem estes handlers isso vira exceção não tratada que
            // derruba o processo (o 502 cru na borda). Aqui vira rejeição tratada pelo chamador.
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('Resposta do Sicoob interrompida.')));
            res.on('close', () => {
                if (!res.complete) reject(new Error('Resposta do Sicoob interrompida (conexão encerrada).'));
            });
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

    // Sandbox: token Bearer fixo (o salvo no painel, senão o público de teste), sem rede/OAuth/mTLS.
    if (environment === 'sandbox') {
        return { token: config.accessToken || SICOOB_SANDBOX_TOKEN, config, environment, api: urls.api };
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
        throw new Error(`Sicoob auth falhou — ${formatSicoobError(response.status, response.body)}`);
    }
    const data: SicoobToken = JSON.parse(response.body);
    _tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
        environment,
    };
    return { token: data.access_token, config, environment, api: urls.api };
}

/**
 * Mensagem legível de um erro do Sicoob. A API segue o padrão Bacen (RFC 7807 "Problema":
 * `{ title, detail, violacoes: [{ razao, propriedade }] }`). Extrai isso quando possível; senão
 * cai no corpo cru truncado. Ex.: "400: Chave inválida — devedor.cpf: CPF inválido".
 */
export function formatSicoobError(status: number, body: string): string {
    try {
        const p = JSON.parse(body);
        const parts: string[] = [];
        if (p?.title) parts.push(String(p.title));
        if (p?.detail && p.detail !== p.title) parts.push(String(p.detail));
        if (Array.isArray(p?.violacoes) && p.violacoes.length) {
            const vs = p.violacoes
                .map((v: any) => [v?.propriedade, v?.razao].filter(Boolean).join(': '))
                .filter(Boolean);
            if (vs.length) parts.push(vs.join('; '));
        }
        if (parts.length) return `${status}: ${parts.join(' — ')}`;
    } catch { /* corpo não-JSON */ }
    return `${status}: ${body.slice(0, 300)}`;
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

// ─── Validação do EMV (BR Code) ──────────────────────────

/**
 * Chave PIX FICTÍCIA do BR Code sintético de sandbox/dev (pagamentos-12): uma chave aleatória (EVP)
 * zerada, que não existe no DICT — o banco lê o QR mas NÃO consegue pagar. Nunca a chave configurada
 * (com a chave real do estúdio, o QR de teste seria pagável de verdade e nada conciliaria).
 */
export const SANDBOX_TEST_PIX_KEY = '00000000-0000-0000-0000-000000000000';
/** Nome/cidade do recebedor usados SÓ no BR Code sintético de sandbox/dev — marcam o QR como teste. */
export const SANDBOX_TEST_MERCHANT_NAME = 'TESTE SANDBOX NAO PAGAR';
export const SANDBOX_TEST_MERCHANT_CITY = 'SANDBOX';

/**
 * Pode usar BR Code SINTÉTICO? Só com o Sicoob em sandbox E fora de produção (dupla trava:
 * ambiente da integração + NODE_ENV do deploy). Em produção é sempre `false`.
 */
export function canUseSyntheticBrCode(environment: 'sandbox' | 'production', nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
    return environment === 'sandbox' && nodeEnv !== 'production';
}

/**
 * Decide o EMV que vai para o cliente a partir do que o Sicoob devolveu (função pura, testável):
 *  • EMV válido → usa o do Sicoob (em sandbox, só se o valor da tag 54 bater ou estiver ausente —
 *    o mock devolve valores aleatórios).
 *  • EMV inválido em PRODUÇÃO → erro (nunca exibir um QR que nenhum banco lê).
 *  • EMV inválido/incoerente em SANDBOX/dev → BR Code sintético estruturalmente VÁLIDO com o valor e
 *    o txid da cobrança, mas com CHAVE FICTÍCIA (SANDBOX_TEST_PIX_KEY) e recebedor "TESTE SANDBOX NAO
 *    PAGAR": o banco lê o QR e recusa o pagamento (a chave não existe no DICT). A confirmação em
 *    sandbox é pelo "Simular pagamento". `pixKey` (a chave configurada) é ignorada de propósito.
 */
export function resolveSicoobEmv(args: {
    emv: string;
    environment: 'sandbox' | 'production';
    amountCents: number;
    txid: string;
    /** Ignorada no sintético (nunca a chave real — pagamentos-12). Mantida por compatibilidade. */
    pixKey?: string;
    nodeEnv?: string;
}): { emv: string; synthetic: boolean } {
    const synthetic = canUseSyntheticBrCode(args.environment, args.nodeEnv ?? process.env.NODE_ENV);
    const valid = isValidBrCode(args.emv);
    if (valid) {
        if (!synthetic) return { emv: args.emv.trim(), synthetic: false };
        const amt = brCodeAmountCents(args.emv);
        if (amt === null || amt === args.amountCents) return { emv: args.emv.trim(), synthetic: false };
    }
    if (!synthetic) {
        throw new Error('O Sicoob retornou um código PIX inválido. Tente novamente em instantes ou use outro método de pagamento.');
    }
    return {
        emv: buildStaticBrCode({
            key: SANDBOX_TEST_PIX_KEY,
            amountCents: args.amountCents,
            txid: args.txid,
            merchantName: SANDBOX_TEST_MERCHANT_NAME,
            city: SANDBOX_TEST_MERCHANT_CITY,
        }),
        synthetic: true,
    };
}

/**
 * Fim da validade da cob: em produção `calendario.criacao + expiracao` (quando a data de criação
 * é plausível); no sandbox (criação aleatória, ex.: 1964) ou sem data → agora + expiracao.
 */
export function computeCobExpiresAt(
    cob: any,
    expiresSeconds: number,
    environment: 'sandbox' | 'production',
    now: Date = new Date(),
): Date {
    const fallback = new Date(now.getTime() + expiresSeconds * 1000);
    if (environment !== 'production') return fallback;
    const criacao = Date.parse(cob?.calendario?.criacao ?? '');
    const exp = Number(cob?.calendario?.expiracao ?? expiresSeconds);
    if (!Number.isFinite(criacao) || !Number.isFinite(exp) || exp <= 0) return fallback;
    // Relógio do provedor muito distante do nosso (> 1 dia) → não confiar.
    if (Math.abs(criacao - now.getTime()) > 24 * 60 * 60 * 1000) return fallback;
    return new Date(criacao + exp * 1000);
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

    // Sem a chave PIX do estúdio o corpo vai sem `chave` (ou com string vazia) e o Sicoob rejeita a
    // cobrança por schema (400) com um erro genérico. Falha aqui com uma mensagem acionável. Em produção
    // a chave não era validada em lugar nenhum (só clientId/cert/key eram).
    if (!config.pixKey || !config.pixKey.trim()) {
        throw new Error('Chave PIX do estúdio não configurada. Cadastre a Chave PIX em Integrações → Sicoob (aba Produção) antes de gerar cobranças.');
    }

    const devedorKey = payload.customer.document.type === 'CNPJ' ? 'cnpj' : 'cpf';
    const expiresSeconds = Math.max(60, Math.round(payload.expiresSeconds ?? 3600));
    const body = JSON.stringify({
        calendario: { expiracao: expiresSeconds },
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
        // Diagnóstico server-side (roda também em produção; o log de sucesso acima é só em dev). Loga
        // quais campos foram enviados (sem valores sensíveis — nada de CPF/chave em claro) e a resposta
        // crua do Sicoob, para achar erros de schema em produção sem ficar às cegas.
        console.error('[Sicoob PIX] cobrança rejeitada', response.status, `(env=${environment})`,
            '| campos:', JSON.stringify({
                expiracao: expiresSeconds,
                devedor: devedorKey,
                temDocumento: !!payload.customer.document.identity,
                temNome: !!payload.customer.name,
                valor: (payload.amount / 100).toFixed(2),
                temChave: !!config.pixKey,
                chaveLen: config.pixKey?.length ?? 0,
                chaveSoDigitos: /^\d+$/.test(config.pixKey || ''),
                temSolicitacaoPagador: !!payload.description?.trim(),
            }),
            '| resposta:', response.body.slice(0, 500));
        throw new Error(`Sicoob criar cobrança falhou — ${formatSicoobError(response.status, response.body)}`);
    }

    let result: any;
    try {
        result = JSON.parse(response.body);
    } catch {
        result = {};
    }
    // BACen usa `pixCopiaECola`; o Sicoob (inclusive o sandbox mock) responde em `brcode`.
    const rawEmv: string = String(result?.pixCopiaECola || result?.brcode || '');
    // D15: nunca exibir um EMV que não seja BR Code válido. Produção → erro; sandbox/dev → BR Code
    // sintético válido com o valor/txid reais e CHAVE FICTÍCIA (travado por ambiente + NODE_ENV).
    const { emv, synthetic } = resolveSicoobEmv({
        emv: rawEmv,
        environment,
        amountCents: payload.amount,
        txid: payload.txid,
    });
    if (synthetic) {
        console.warn(`[Sicoob PIX] sandbox: EMV do mock inválido/incoerente ("${rawEmv.slice(0, 30)}") — usando BR Code sintético (txid ${payload.txid}).`);
    }
    const expiresAt = computeCobExpiresAt(result, expiresSeconds, environment);

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
        // O status do mock é aleatório (ex.: CONCLUIDA recém-criada) — em sandbox a cob nasce ATIVA.
        status: environment === 'sandbox' ? 'ATIVA' : (result?.status || 'ATIVA'),
        expiresAt,
        synthetic,
    };
}

/**
 * Cancela (remove) uma cobrança imediata ainda não paga: PATCH /cob/{txid} com
 * status REMOVIDA_PELO_USUARIO_RECEBEDOR (padrão API Pix Bacen). BEST-EFFORT: nunca lança;
 * devolve `true` se o Sicoob aceitou a remoção. Usado antes de reemitir um QR (a cobrança antiga
 * não pode continuar pagável com um txid que não casa mais com o Payment) e na varredura de
 * reservas/contratos abandonados.
 */
export async function sicoobRemoveCob(txid: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9]{26,35}$/.test(txid || '')) return false;
    try {
        const { token, config, environment, api } = await sicoobAuth();
        const response = await httpsCall(`${api}/cob/${txid}`, {
            method: 'PATCH',
            headers: sicoobHeaders(token, config.clientId),
            body: JSON.stringify({ status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }),
            cert: environment === 'production' ? config.certificatePem : undefined,
            key: environment === 'production' ? config.privateKeyPem : undefined,
        });
        if (response.status >= 400) {
            console.warn(`[Sicoob PIX] remover cobrança ${txid} recusado — ${formatSicoobError(response.status, response.body)}`);
            return false;
        }
        return true;
    } catch (err) {
        console.warn(`[Sicoob PIX] remover cobrança ${txid} falhou:`, err instanceof Error ? err.message : err);
        return false;
    }
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
        throw new Error(`Sicoob consultar cobrança falhou — ${formatSicoobError(response.status, response.body)}`);
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
        throw new Error(`Sicoob registrar webhook falhou — ${formatSicoobError(response.status, response.body)}`);
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
        throw new Error(`Sicoob consultar webhook falhou — ${formatSicoobError(response.status, response.body)}`);
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
        throw new Error(`Sicoob remover webhook falhou — ${formatSicoobError(response.status, response.body)}`);
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
    // Mensagem clara quando o ambiente ativo no painel não bate com o permitido por este deploy
    // (senão getSicoobConfig retorna null e o teste diria só "não configurada").
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'SICOOB' } });
    if (integration) {
        const stored = integration.environment === 'production' ? 'production' : 'sandbox';
        const allowedEnv = sicoobAllowedEnvironment();
        if (stored !== allowedEnv) {
            return {
                success: false,
                message: `Ambiente ativo "${sicoobEnvLabel(stored)}" não é permitido neste servidor (${allowedEnv === 'production' ? 'produção' : 'desenvolvimento/homologação'}). Aqui o Sicoob só opera em "${sicoobEnvLabel(allowedEnv)}". Selecione "${sicoobEnvLabel(allowedEnv)}" como ambiente ativo e salve.`,
            };
        }
    }

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
