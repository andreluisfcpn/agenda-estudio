// ─── Cora Payment Helper ────────────────────────────────
// Centralizes all PIX/Boleto payment creation via Cora API.
// Single source of truth for address parsing, CPF validation,
// and coraCreateBoleto calls — used by bookings, contracts, and stripe routes.

import { prisma } from './prisma.js';
import { coraCreateBoleto, isCoraEnabled, type CoraBoletoResult } from './coraService.js';

// ─── Types ───────────────────────────────────────────────

export interface CoraPaymentRequest {
    userId: string;
    amount: number;          // in cents
    description: string;
    withPixQrCode: boolean;  // true = PIX, false = boleto puro
    dueDays?: number;        // days from now until due (default: 1 for PIX, 3 for boleto)
}

export interface CoraPaymentResponse {
    result: CoraBoletoResult;
    pixString: string | null;
    qrCodeBase64: string | null;
    boletoUrl: string | null;
    barcode: string | null;
}

// ─── Address Parser ──────────────────────────────────────

function parseUserAddress(user: { address?: string | null; city?: string | null; state?: string | null }) {
    if (user.address) {
        try {
            const addr = JSON.parse(user.address);
            return {
                street: addr.street || 'N/A',
                number: addr.number || 'S/N',
                district: addr.district || 'Centro',
                city: addr.city || user.city || 'Cidade',
                state: addr.state || user.state || 'RJ',
                zipCode: (addr.zipCode || addr.cep || '00000000').replace(/\D/g, ''),
            };
        } catch { /* fall through */ }
    }
    return {
        street: 'N/A',
        number: 'S/N',
        district: 'Centro',
        city: user.city || 'Cidade',
        state: user.state || 'RJ',
        zipCode: '00000000',
    };
}

// ─── CPF/CNPJ Validator ──────────────────────────────────

function validateDocument(cpfCnpj: string | null | undefined): { docStr: string; docType: 'CPF' | 'CNPJ' } | null {
    const docStr = cpfCnpj ? cpfCnpj.replace(/\D/g, '') : '';
    if (docStr.length !== 11 && docStr.length !== 14) return null;
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

    // Calculate due date
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
        customer: {
            name: user.name,
            email: user.email || 'cliente@estudio.com',
            document: { type: doc.docType, identity: doc.docStr },
            address: addressData,
        },
    });

    return {
        result,
        pixString: result.pixString || null,
        qrCodeBase64: result.qrCodeBase64 || null,
        boletoUrl: result.boletoUrl || null,
        barcode: result.barcode || null,
    };
}
