// ─── Cora Bank API Service ──────────────────────────────
// Handles OAuth2 authentication and boleto/PIX emission via Cora API
// Docs: https://developers.cora.com.br

import { prisma } from './prisma';
import https from 'https';

// ─── Types ───────────────────────────────────────────────

interface CoraConfig {
    clientId: string;
    certificatePem: string;
    privateKeyPem: string;
    pixKey: string;
    webhookSecret?: string;
}

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

let _tokenCache: { token: string; expiresAt: number } | null = null;

// ─── API URLs ────────────────────────────────────────────

const CORA_URLS = {
    sandbox: {
        auth: 'https://matls-clients.api.stage.cora.com.br/token',
        api: 'https://api.stage.cora.com.br',
    },
    production: {
        auth: 'https://matls-clients.api.cora.com.br/token',
        api: 'https://api.cora.com.br',
    },
};

// ─── Helpers ─────────────────────────────────────────────

async function getCoraConfig(): Promise<{ config: CoraConfig; environment: string } | null> {
    const integration = await prisma.integrationConfig.findUnique({ where: { provider: 'CORA' } });
    if (!integration || !integration.enabled) return null;
    try {
        const config = JSON.parse(integration.config) as CoraConfig;
        return { config, environment: integration.environment };
    } catch {
        return null;
    }
}

function createHttpsAgent(config: CoraConfig): https.Agent {
    return new https.Agent({
        cert: config.certificatePem,
        key: config.privateKeyPem,
        rejectUnauthorized: true,
    });
}

// ─── Public API ──────────────────────────────────────────

export async function coraAuthenticate(): Promise<string> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured or disabled');

    // Check cache
    if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
        return _tokenCache.token;
    }

    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;

    const agent = createHttpsAgent(config);
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
    });

    const response = await fetch(urls.auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        // @ts-ignore — Node fetch supports dispatcher/agent
        dispatcher: agent,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cora auth failed (${response.status}): ${text}`);
    }

    const data: CoraToken = await response.json() as CoraToken;
    _tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
    };

    return data.access_token;
}

export async function coraCreateBoleto(payload: CoraBoletoPayload): Promise<CoraBoletoResult> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;
    const agent = createHttpsAgent(config);

    // PIX QR Code uses a separate endpoint from boleto
    if (payload.withPixQrCode) {
        return coraCreatePixQrCode(payload, token, urls, agent);
    }

    // ─── Boleto Registrado: POST /v2/invoices ────────────
    const body = {
        code: `boleto-${Date.now()}`,
        customer: {
            name: payload.customer.name,
            email: payload.customer.email,
            document: payload.customer.document,
            address: payload.customer.address,
        },
        services: [{
            name: payload.description,
            amount: payload.amount,
        }],
        payment_terms: {
            due_date: payload.dueDate,
            ...(payload.finePercentage ? { fine: { percentage: payload.finePercentage } } : {}),
            ...(payload.interestPercentage ? { interest: { type: 'MONTHLY_PERCENTAGE', value: payload.interestPercentage } } : {}),
        },
    };

    const response = await fetch(`${urls.api}/v2/invoices`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `boleto-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        body: JSON.stringify(body),
        // @ts-ignore
        dispatcher: agent,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cora create boleto failed (${response.status}): ${text}`);
    }

    const result = await response.json() as any;

    return {
        id: result.id,
        barcode: result.barcode || result.digitable_line || '',
        boletoUrl: result.payment_url || result.bank_slip_url || '',
        pixString: undefined,
        qrCodeBase64: undefined,
        status: result.status || 'PENDING',
    };
}

/** PIX QR Code: POST /v2/pix-qrcode (separate Cora endpoint) */
async function coraCreatePixQrCode(
    payload: CoraBoletoPayload,
    token: string,
    urls: { auth: string; api: string },
    agent: https.Agent
): Promise<CoraBoletoResult> {
    const body = {
        code: `pix-${Date.now()}`,
        amount: payload.amount,
        customer: {
            name: payload.customer.name,
            email: payload.customer.email,
            document: payload.customer.document,
        },
        description: payload.description,
        expiration_date: payload.dueDate,
    };

    const response = await fetch(`${urls.api}/v2/pix-qrcode`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `pix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
        body: JSON.stringify(body),
        // @ts-ignore
        dispatcher: agent,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Cora create PIX QR code failed (${response.status}): ${text}`);
    }

    const result = await response.json() as any;

    return {
        id: result.id,
        barcode: '',
        boletoUrl: '',
        pixString: result.emv || result.pix_string || result.qr_code_text || '',
        qrCodeBase64: result.qr_code_base64 || result.image_base64 || undefined,
        status: result.status || 'PENDING',
    };
}

export async function coraGetBoleto(boletoId: string): Promise<any> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;
    const agent = createHttpsAgent(config);

    const response = await fetch(`${urls.api}/v2/invoices/${boletoId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
        // @ts-ignore
        dispatcher: agent,
    });

    if (!response.ok) {
        throw new Error(`Cora get boleto failed (${response.status})`);
    }

    return response.json();
}

export async function coraCancelBoleto(boletoId: string): Promise<void> {
    const setup = await getCoraConfig();
    if (!setup) throw new Error('Cora integration not configured');

    const token = await coraAuthenticate();
    const { config, environment } = setup;
    const urls = CORA_URLS[environment as keyof typeof CORA_URLS] || CORA_URLS.sandbox;
    const agent = createHttpsAgent(config);

    const response = await fetch(`${urls.api}/v2/invoices/${boletoId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
        // @ts-ignore
        dispatcher: agent,
    });

    if (!response.ok) {
        throw new Error(`Cora cancel boleto failed (${response.status})`);
    }
}

/** Test connectivity — tries to authenticate and returns success/error */
export async function coraTestConnection(): Promise<{ success: boolean; message: string }> {
    try {
        await coraAuthenticate();
        _tokenCache = null; // Clear cache after test
        return { success: true, message: 'Autenticação Cora realizada com sucesso!' };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        return { success: false, message: `Falha na autenticação: ${msg}` };
    }
}

/** Check if Cora integration is configured and enabled */
export async function isCoraEnabled(): Promise<boolean> {
    const setup = await getCoraConfig();
    return setup !== null;
}
