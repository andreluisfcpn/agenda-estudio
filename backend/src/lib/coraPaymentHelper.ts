// ─── Cora Payment Helper ────────────────────────────────
// Centralizes all PIX/Boleto payment creation via Cora API.
// Single source of truth for address parsing, CPF validation,
// and coraCreateBoleto calls — used by bookings, contracts, and stripe routes.

import { prisma } from './prisma.js';
import { coraCreateBoleto, isCoraEnabled, type CoraBoletoResult } from './coraService.js';
import { cleanDocument, isValidCpfCnpj } from '../utils/document.js';

// ─── Types ───────────────────────────────────────────────

export interface CoraPaymentRequest {
    userId: string;
    amount: number;          // in cents
    description: string;
    withPixQrCode: boolean;  // true = PIX, false = boleto puro
    dueDays?: number;        // days from now until due (default: 1 for PIX, 3 for boleto)
    idempotencyKey?: string; // stable per-payment key → retries reuse the same Cora invoice
}

export interface CoraPaymentResponse {
    result: CoraBoletoResult;
    pixString: string | null;
    qrCodeBase64: string | null;
    boletoUrl: string | null;
    barcode: string | null;
}

// ─── Address Parser ──────────────────────────────────────

function parseUserAddress(user: {
    address?: string | null; addressNumber?: string | null; complement?: string | null;
    neighborhood?: string | null; zipCode?: string | null; city?: string | null; state?: string | null;
}) {
    // Back-compat: linhas antigas guardavam um blob JSON no campo `address`.
    if (user.address && user.address.trim().startsWith('{')) {
        try {
            const addr = JSON.parse(user.address);
            return {
                street: addr.street || 'N/A',
                number: addr.number || 'S/N',
                district: addr.district || 'Centro',
                city: addr.city || user.city || 'Cidade',
                state: (addr.state || user.state || 'RJ').slice(0, 2).toUpperCase(),
                zipCode: (addr.zipCode || addr.cep || '00000000').replace(/\D/g, '') || '00000000',
            };
        } catch { /* fall through para os campos estruturados */ }
    }
    // Formato atual: colunas separadas (address = logradouro).
    return {
        street: user.address || 'N/A',
        number: user.addressNumber || 'S/N',
        district: user.neighborhood || 'Centro',
        city: user.city || 'Cidade',
        state: (user.state || 'RJ').slice(0, 2).toUpperCase(),
        zipCode: (user.zipCode || '00000000').replace(/\D/g, '') || '00000000',
    };
}

// ─── CPF/CNPJ Validator ──────────────────────────────────

function validateDocument(cpfCnpj: string | null | undefined): { docStr: string; docType: 'CPF' | 'CNPJ' } | null {
    const docStr = cleanDocument(cpfCnpj);
    if (!isValidCpfCnpj(docStr)) return null;
    return { docStr, docType: docStr.length === 14 ? 'CNPJ' : 'CPF' };
}

// ─── Main Function ───────────────────────────────────────

/**
 * Creates a PIX or Boleto payment via Cora API.
 * Centralizes user lookup, CPF validation, address parsing, and Cora call.
 *
 * @throws Error if Cora is not enabled, user not found, or CPF is invalid
 */
export async function createCoraPayment(req: CoraPaymentRequest): Promise<CoraPaymentResponse> {
    // Check Cora is enabled
    if (!(await isCoraEnabled())) {
        throw new Error('Cora não está habilitado. Configure as credenciais no painel admin.');
    }

    // Fetch user
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
        throw new Error('Usuário não encontrado.');
    }

    // Validate CPF/CNPJ
    const doc = validateDocument(user.cpfCnpj);
    if (!doc) {
        throw new Error('CPF/CNPJ não cadastrado ou inválido. Atualize o perfil antes de pagar com PIX/Boleto.');
    }

    // Calculate due date (now + dueDays). Note: this is recomputed per call, so a retry that
    // crosses midnight produces a different due_date in the request body. That does NOT create a
    // duplicate invoice — the deterministic Idempotency-Key (the raw payment UUID) makes Cora return
    // the original invoice for a repeated key. The body delta only matters if Cora strictly
    // rejects same-key/different-body (rare; Stripe-style idempotency returns the cached response),
    // in which case the (very rare) midnight-crossing retry surfaces an error and the user retries.
    const defaultDueDays = req.withPixQrCode ? 1 : 3;
    const dueDays = req.dueDays ?? defaultDueDays;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);

    // Parse address
    const addressData = parseUserAddress(user);

    // Call Cora API
    const result = await coraCreateBoleto({
        amount: req.amount,
        dueDate: dueDate.toISOString().split('T')[0],
        description: req.description,
        withPixQrCode: req.withPixQrCode,
        idempotencyKey: req.idempotencyKey,
        customer: {
            name: user.name,
            email: user.email || 'cliente@estudio.com',
            document: { type: doc.docType, identity: doc.docStr },
            address: addressData,
        },
    });

    // A 2xx Cora response that lacks the payable artifact (PIX EMV when a QR was
    // requested, or a boleto URL) is unpayable — fail loudly so callers return an
    // error instead of persisting a blank QR/boleto the client would poll forever.
    if (req.withPixQrCode && !result.pixString) {
        throw new Error('A Cora não retornou o código PIX. Tente novamente em instantes.');
    }
    if (!req.withPixQrCode && !result.boletoUrl) {
        throw new Error('A Cora não retornou o boleto. Tente novamente em instantes.');
    }

    return {
        result,
        pixString: result.pixString || null,
        qrCodeBase64: result.qrCodeBase64 || null,
        boletoUrl: result.boletoUrl || null,
        barcode: result.barcode || null,
    };
}
