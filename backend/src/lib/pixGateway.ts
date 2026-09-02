// ─── PIX Provider Router ────────────────────────────────
// O PIX pode ser atendido por SICOOB ou CORA. O admin habilita um (ou ambos) no
// painel; este módulo resolve qual usar (preferência: Sicoob) e cria a cobrança
// no provedor certo, devolvendo o MESMO formato que o helper da Cora — para os
// call sites trocarem `createCoraPayment` por `createPixPayment` sem outra mudança.

import { prisma } from './prisma.js';
import { sicoobCreatePix } from './sicoobService.js';
import { createCoraPayment, type CoraPaymentRequest, type CoraPaymentResponse } from './coraPaymentHelper.js';
import { cleanDocument, isValidCpfCnpj } from '../utils/document.js';

export type PixProvider = 'SICOOB' | 'CORA';

/** Deriva um txid Sicoob válido (26–35 alfanuméricos) a partir de uma chave estável. */
export function toSicoobTxid(seed: string): string {
    const alnum = (seed || '').replace(/[^a-zA-Z0-9]/g, '');
    // UUID sem hífens = 32 chars (dentro de 26–35). Garante mínimo de 26 com padding determinístico.
    return (alnum.length >= 26 ? alnum : (alnum + '0'.repeat(26)).slice(0, 26)).slice(0, 35);
}

/** Resolve o provedor de PIX ativo. Preferência: Sicoob → Cora. `null` se nenhum habilitado. */
export async function resolvePixProvider(): Promise<PixProvider | null> {
    const integrations = await prisma.integrationConfig.findMany({
        where: { provider: { in: ['SICOOB', 'CORA'] }, enabled: true },
        select: { provider: true },
    });
    const enabled = new Set(integrations.map(i => i.provider));
    if (enabled.has('SICOOB')) return 'SICOOB';
    if (enabled.has('CORA')) return 'CORA';
    return null;
}

/** Há ao menos um provedor de PIX habilitado? */
export async function isAnyPixProviderEnabled(): Promise<boolean> {
    return (await resolvePixProvider()) !== null;
}

export interface PixPaymentResponse extends CoraPaymentResponse {
    provider: PixProvider;
}

function validateDocument(cpfCnpj: string | null | undefined) {
    const docStr = cleanDocument(cpfCnpj);
    if (!isValidCpfCnpj(docStr)) return null;
    return { docStr, docType: docStr.length === 14 ? ('CNPJ' as const) : ('CPF' as const) };
}

/**
 * Cria uma cobrança PIX no provedor ativo (Sicoob ou Cora) para um usuário.
 * Mesmo shape de resposta do `createCoraPayment`, com o campo `provider` a mais.
 * @throws se nenhum provedor de PIX estiver habilitado, usuário não existir ou CPF inválido.
 */
export async function createPixPayment(req: CoraPaymentRequest): Promise<PixPaymentResponse> {
    const provider = await resolvePixProvider();
    if (!provider) {
        throw new Error('Nenhum provedor de PIX está habilitado. Configure o Sicoob (ou Cora) no painel admin.');
    }

    if (provider === 'CORA') {
        const res = await createCoraPayment(req);
        return { ...res, provider: 'CORA' };
    }

    // ─── SICOOB ───
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new Error('Usuário não encontrado.');
    const doc = validateDocument(user.cpfCnpj);
    if (!doc) {
        throw new Error('CPF/CNPJ não cadastrado ou inválido. Atualize o perfil antes de pagar com PIX.');
    }

    const result = await sicoobCreatePix({
        amount: req.amount,
        txid: toSicoobTxid(req.idempotencyKey || req.userId),
        description: req.description,
        customer: { name: user.name, document: { identity: doc.docStr, type: doc.docType } },
    });
    if (!result.pixString) {
        throw new Error('O Sicoob não retornou o código PIX. Tente novamente em instantes.');
    }

    return {
        provider: 'SICOOB',
        result: {
            id: result.id,
            barcode: '',
            boletoUrl: '',
            pixString: result.pixString,
            qrCodeBase64: result.qrCodeBase64,
            status: result.status,
        },
        pixString: result.pixString,
        qrCodeBase64: result.qrCodeBase64 || null,
        boletoUrl: null,
        barcode: null,
    };
}
