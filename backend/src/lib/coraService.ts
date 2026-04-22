// ─── Cora Bank API Service ──────────────────────────────
// Handles OAuth2 authentication and boleto/PIX emission via Cora API
// Mode: Integração Direta (mTLS on all endpoints)
// Docs: https://developers.cora.com.br
//
// Uses node:https directly for mTLS (client certificate auth).
// Node's native fetch (undici) does NOT support https.Agent for mTLS.

import { prisma } from './prisma.js';
import https from 'https';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { decryptConfigSafe } from '../utils/crypto.js';

// ─── Types ───────────────────────────────────────────────

/** Credentials for a single Cora environment (sandbox or production) */
interface CoraCredentials {
    clientId: string;
    certificatePem: string;
    privateKeyPem: string;
    pixKey: string;
    webhookSecret?: string;
}

/**
 * Dual-environment config stored in IntegrationConfig.config (encrypted JSON).
 * Both sandbox and production credentials are stored together.
 * The admin selects which environment is active via IntegrationConfig.environment.
 */
interface CoraConfigDual {
    sandbox?: CoraCredentials;
    production?: CoraCredentials;
}

/** Legacy flat format (backward-compat — treated as sandbox credentials) */
interface CoraConfigLegacy extends CoraCredentials {}

interface CoraToken {
    access_token: string;
    expires_in: number;
    token_type: string;
}

interface CoraCustomer {
    name: string;
    email: string;
    document: { identity: string; type: 'CPF' | 'CNPJ' };
    address?: {
        street: string;
        number: string;
        district: string;
        city: string;
        state: string;
        zipCode: string;
    };
}

export interface CoraBoletoPayload {
    amount: number;          // in cents
    dueDate: string;         // YYYY-MM-DD
    customer: CoraCustomer;
    description: string;
    withPixQrCode: boolean;  // true = boleto + PIX
    finePercentage?: number;
    interestPercentage?: number;
}

export interface CoraBoletoResult {
    id: string;
    barcode: string;
    boletoUrl: string;
    pixString?: string;
    qrCodeBase64?: string;
    status: string;
}

// ─── Token Cache ─────────────────────────────────────────

let _tokenCache: { token: string; expiresAt: number; environment: string } | null = null;

// ─── API URLs ────────────────────────────────────────────

const CORA_URLS = {
    sandbox: {
        auth: 'https://matls-clients.api.stage.cora.com.br/token',
        api: 'https://matls-clients.api.stage.cora.com.br',
    },
    production: {
        auth: 'https://matls-clients.api.cora.com.br/token',
        api: 'https://matls-clients.api.cora.com.br',
    },
};

// ─── Config Parser ───────────────────────────────────────
// Supports two config formats:
//   1. Dual (new):  { sandbox: { clientId, cert, key, pix }, production: { ... } }
//   2. Legacy (flat): { clientId, cert, key, pix } → treated as sandbox
//
// The admin selects the active environment via IntegrationConfig.environment.

function isDualConfig(parsed: any): parsed is CoraConfigDual {
    return parsed && (typeof parsed.sandbox === 'object' || typeof parsed.production === 'object');
}

function fixNewlines(creds: CoraCredentials): CoraCredentials {
    if (creds.certificatePem) creds.certificatePem = creds.certificatePem.replace(/\\n/g, '\n');
    if (creds.privateKeyPem)  creds.privateKeyPem  = creds.privateKeyPem.replace(/\\n/g, '\n');
    return creds;
}

// ─── Helpers ─────────────────────────────────────────────

async function getCoraConfig(): Promise<{ config: CoraCredentials; environment: string } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'CORA' } });
    if (!integration || !integration.enabled) return null;
    try {
        const decrypted = decryptConfigSafe(integration.config);
        const parsed = JSON.parse(decrypted);

        const environment = (integration.environment === 'production' ? 'production' : 'sandbox') as 'sandbox' | 'production';

        let credentials: CoraCredentials | undefined;

        if (isDualConfig(parsed)) {
            // New format: pick credentials for the active environment
            credentials = parsed[environment];
            if (!credentials?.clientId) {
                console.warn(`[Cora] No credentials configured for environment "${environment}"`);
                return null;
            }
        } else {
            // Legacy flat format → treat as sandbox credentials
            credentials = parsed as CoraConfigLegacy;
            if (environment === 'production') {
                console.warn('[Cora] Legacy flat config detected but environment is "production". Using flat credentials anyway.');
            }
        }

        return { config: fixNewlines(credentials), environment };
    } catch {
        return null;
    }
}

/**
 * Makes an HTTPS request with mTLS client certificate.
 * Uses node:https directly because `fetch` (undici) does NOT support https.Agent.
 */
function httpsRequest(
    url: string,
    options: {
        method: string;
        headers?: Record<string, string>;
        body?: string;
        cert: string;
        key: string;
    }
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);

        const reqOptions: https.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: options.method,
            headers: options.headers || {},
            cert: options.cert,
            key: options.key,
            rejectUnauthorized: true,
        };

        if (options.body) {
            (reqOptions.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(options.body, 'utf-8').toString();
        }

        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                resolve({ status: res.statusCode || 500, body });
            });
        });

        req.on('error', reject);
        req.setTimeout(30_000, () => {
            req.destroy(new Error('Request timeout (30s)'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

/**
 * Makes an HTTPS request with optional mTLS.
 * Cora Integração Direta requires mTLS (cert+key) on ALL endpoints,
 * so cert/key should always be provided.
 */
function httpsRequestWithToken(
    url: string,
    options: {
        method: string;
        headers?: Record<string, string>;
        body?: string;
        cert?: string;
        key?: string;
    }
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

        // mTLS certs if provided (Cora requires mTLS on ALL endpoints)
        if (options.cert) reqOptions.cert = options.cert;
        if (options.key) reqOptions.key = options.key;

        if (options.body) {
            (reqOptions.headers as Record<string, string>)['Content-Length'] = Buffer.byteLength(options.body, 'utf-8').toString();
        }

        const req = https.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                resolve({ status: res.statusCode || 500, body });
            });
        });

        req.on('error', reject);
        req.setTimeout(30_000, () => {
            req.destroy(new Error('Request timeout (30s)'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// ─── Public API ──────────────────────────────────────────

export async function coraAuthenticate(): Promise<string> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured or disabled');

    const { config, environment } = setup;

    // Check cache — invalidate if environment changed (admin switched via panel)
    if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000 && _tokenCache.environment === environment) {
        return _tokenCache.token;
    }

    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
    }).toString();

    const response = await httpsRequest(urls.auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (response.status >= 400) {
        throw new Error(`Cora auth failed (${response.status}): ${response.body}`);
    }

    const data: CoraToken = JSON.parse(response.body);
    _tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
        environment,
    };

    return data.access_token;
}

export async function coraCreateBoleto(payload: CoraBoletoPayload): Promise<CoraBoletoResult> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    // Clear cached token if it was obtained without scopes
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    // PIX QR Code uses a separate endpoint from boleto
    if (payload.withPixQrCode) {
        return coraCreatePixQrCode(payload, token, urls, config);
    }

    // ─── Boleto Registrado: POST /v2/invoices ────────────
    const body = JSON.stringify({
        code: `boleto-${Date.now()}`,
        customer: {
            name: payload.customer.name,
            email: payload.customer.email,
            document: payload.customer.document,
            address: payload.customer.address ? {
                street: payload.customer.address.street,
                number: payload.customer.address.number,
                district: payload.customer.address.district,
                city: payload.customer.address.city,
                state: payload.customer.address.state,
                complement: 'N/A',
                zip_code: payload.customer.address.zipCode,
            } : undefined,
        },
        services: [{
            name: payload.description,
            amount: payload.amount,
        }],
        payment_terms: {
            due_date: payload.dueDate,
            ...(payload.finePercentage ? { fine: { amount: payload.finePercentage } } : {}),
            ...(payload.interestPercentage ? { interest: { rate: payload.interestPercentage } } : {}),
        },
        payment_forms: ['BANK_SLIP']
    });

    const response = await httpsRequestWithToken(`${urls.api}/v2/invoices`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
        },
        body,
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (response.status >= 400) {
        throw new Error(`Cora create boleto failed (${response.status}): ${response.body}`);
    }

    const result = JSON.parse(response.body);

    // Cora v2 response: payment_options.bank_slip.{barcode,digitable,url}
    const bankSlip = result.payment_options?.bank_slip;

    return {
        id: result.id,
        barcode: bankSlip?.digitable || bankSlip?.barcode || '',
        boletoUrl: bankSlip?.url || '',
        pixString: undefined,
        qrCodeBase64: undefined,
        status: result.status || 'PENDING',
    };
}

/** PIX QR Code (somente PIX, sem boleto) via Cora Invoices: POST /v2/invoices */
async function coraCreatePixQrCode(
    payload: CoraBoletoPayload,
    token: string,
    urls: { auth: string; api: string },
    config: CoraCredentials
): Promise<CoraBoletoResult> {
    // Use existing cached token (no need to force-clear)
    const freshToken = token;

    const body = JSON.stringify({
        code: `pix-${Date.now()}`,
        customer: {
            name: payload.customer.name,
            email: payload.customer.email,
            document: payload.customer.document,
            address: payload.customer.address ? {
                street: payload.customer.address.street,
                number: payload.customer.address.number,
                district: payload.customer.address.district,
                city: payload.customer.address.city,
                state: payload.customer.address.state,
                complement: 'N/A',
                zip_code: payload.customer.address.zipCode,
            } : undefined,
        },
        services: [{
            name: payload.description,
            amount: payload.amount,
        }],
        payment_terms: {
            due_date: payload.dueDate,
        },
        payment_forms: ['PIX']
    });

    if (process.env.NODE_ENV !== 'production') {
        console.log('[Cora PIX] URL:', `${urls.api}/v2/invoices`);
        console.log('[Cora PIX] Body:', body);
    }

    const response = await httpsRequestWithToken(`${urls.api}/v2/invoices`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${freshToken}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
        },
        body,
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (process.env.NODE_ENV !== 'production') {
        console.log('[Cora PIX] Response status:', response.status);
        console.log('[Cora PIX] Response body:', response.body.substring(0, 200));
    }

    if (response.status >= 400) {
        throw new Error(`Cora create PIX QR code failed (${response.status}): ${response.body}`);
    }

    const result = JSON.parse(response.body);

    // Cora v2 response structure (PIX-only, sem BANK_SLIP):
    //   result.pix.emv — PIX "Copia e Cola" string (BRCode)
    //   Cora does NOT return qr_code_base64 — we generate it from EMV
    //   bank_slip data is NOT present because payment_forms is ['PIX'] only
    const emv = result.pix?.emv || '';

    // Generate QR code base64 from EMV string (Cora only returns the text)
    let qrCodeBase64: string | undefined;
    if (emv) {
        try {
            const dataUrl = await QRCode.toDataURL(emv, { width: 256, margin: 2 });
            // Strip "data:image/png;base64," prefix — frontend adds it back
            qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        } catch (err) {
            console.error('[Cora PIX] Failed to generate QR code from EMV:', err);
        }
    }

    return {
        id: result.id,
        barcode: '',
        boletoUrl: '',
        pixString: emv,
        qrCodeBase64,
        status: result.status || 'PENDING',
    };
}

export async function coraGetBoleto(boletoId: string): Promise<any> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const response = await httpsRequestWithToken(`${urls.api}/v2/invoices/${boletoId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (response.status >= 400) {
        throw new Error(`Cora get boleto failed (${response.status})`);
    }

    return JSON.parse(response.body);
}

export async function coraCancelBoleto(boletoId: string): Promise<void> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const response = await httpsRequestWithToken(`${urls.api}/v2/invoices/${boletoId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (response.status >= 400) {
        throw new Error(`Cora cancel boleto failed (${response.status})`);
    }
}

/** Test connectivity — tries to authenticate and returns success/error */
export async function coraTestConnection(): Promise<{ success: boolean; message: string }> {
    try {
        await coraAuthenticate();
        _tokenCache = null; // Clear cache after test
        const setup = await getCoraConfig();
        const env = setup?.environment || 'unknown';
        return { success: true, message: `Autenticação Cora realizada com sucesso! (mTLS OK, ambiente: ${env})` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        // Provide more helpful error messages
        if (msg.includes('ECONNREFUSED')) {
            return { success: false, message: 'Conexão recusada. Verifique se o ambiente (sandbox/produção) está correto.' };
        }
        if (msg.includes('certificate') || msg.includes('key')) {
            return { success: false, message: 'Erro no certificado mTLS. Verifique se o certificado e chave privada estão corretos e no formato PEM.' };
        }
        if (msg.includes('client_id') || msg.includes('401')) {
            return { success: false, message: 'Client ID inválido ou não autorizado. Verifique suas credenciais no painel Cora.' };
        }
        return { success: false, message: `Falha na autenticação: ${msg}` };
    }
}

/** Check if Cora integration is configured and enabled */
export async function isCoraEnabled(): Promise<boolean> {
    const setup = await getCoraConfig();
    return setup !== null;
}

// ─── Webhook Management (via Cora API) ──────────────────

export interface CoraWebhookEndpoint {
    id: string;
    url: string;
    events?: string[];
    created_at?: string;
}

/** List all registered webhook endpoints */
export async function coraListWebhookEndpoints(): Promise<CoraWebhookEndpoint[]> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const response = await httpsRequestWithToken(`${urls.api}/endpoints/`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (response.status >= 400) {
        throw new Error(`Cora list webhooks failed (${response.status}): ${response.body}`);
    }

    const data = JSON.parse(response.body);
    return Array.isArray(data) ? data : (data.items || data.endpoints || []);
}

/** Register a new webhook endpoint on Cora */
export async function coraRegisterWebhookEndpoint(
    webhookUrl: string,
    events: string[] = ['INVOICE.PAID', 'INVOICE.CANCELLED', 'INVOICE.OVERDUE'],
): Promise<CoraWebhookEndpoint> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const { randomUUID } = await import('crypto');

    const body = JSON.stringify({ url: webhookUrl, events });

    const response = await httpsRequestWithToken(`${urls.api}/endpoints/`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
        },
        cert: config.certificatePem,
        key: config.privateKeyPem,
        body,
    });

    if (response.status >= 400) {
        throw new Error(`Cora register webhook failed (${response.status}): ${response.body}`);
    }

    return JSON.parse(response.body);
}

/** Delete a webhook endpoint from Cora */
export async function coraDeleteWebhookEndpoint(endpointId: string): Promise<void> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const response = await httpsRequestWithToken(`${urls.api}/endpoints/${endpointId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        cert: config.certificatePem,
        key: config.privateKeyPem,
    });

    if (response.status >= 400) {
        throw new Error(`Cora delete webhook failed (${response.status}): ${response.body}`);
    }
}
