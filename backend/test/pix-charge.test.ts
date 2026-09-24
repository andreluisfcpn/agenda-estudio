import { describe, it, expect, vi } from 'vitest';

// Teste UNITÁRIO: nenhuma função daqui pode ir ao banco. Qualquer chamada ao prisma é registrada e
// rejeitada — em especial, cardChargeBaseAmount decide só pela linha recebida (D1, regra única).
const { dbCalls } = vi.hoisted(() => ({ dbCalls: [] as string[] }));
vi.mock('../src/lib/prisma', () => {
    const model = (name: string) => new Proxy({}, {
        get: (_t, op) => (..._args: unknown[]) => {
            dbCalls.push(`${name}.${String(op)}`);
            return Promise.reject(new Error(`acesso ao banco num teste unitário: ${name}.${String(op)}`));
        },
    });
    return { prisma: new Proxy({}, { get: (_t, name) => model(String(name)) }) };
});

import {
    toSicoobTxid, pixTxidForAttempt, pixIdempotencyKeyForAttempt, nextPixAttempt,
    isPixChargeReusable, pixExpirySecondsFor, pixMetadataAfterDiscard, readPixChargeMeta,
    mergePaymentMetadata, PIX_DEFAULT_EXPIRES_SECONDS, PIX_MIN_EXPIRES_SECONDS,
    readPixDiscountMeta, buildPixDiscountMeta, cardChargeBaseAmount, paidChargedAmount,
    pixDiscountMetaForCharge,
} from '../src/lib/pixGateway';
import * as pixGateway from '../src/lib/pixGateway';
import { buildStaticBrCode } from '../src/lib/brcode';

const PID = '32ce29bf-7741-4f3d-b8a9-52ed6b652812';
const TXID_RE = /^[a-zA-Z0-9]{26,35}$/;

describe('txid por tentativa (D15)', () => {
    it('1ª emissão mantém o txid legado (compatível com providerRefs existentes)', () => {
        expect(pixTxidForAttempt(PID, 1)).toBe(toSicoobTxid(PID));
        expect(pixTxidForAttempt(PID)).toBe('32ce29bf77414f3db8a952ed6b652812');
    });
    it('2ª em diante ganha sufixo base36 e continua válido (26–35 alfanuméricos)', () => {
        const t2 = pixTxidForAttempt(PID, 2);
        const t3 = pixTxidForAttempt(PID, 3);
        const t40 = pixTxidForAttempt(PID, 40);
        expect(t2).toBe('32ce29bf77414f3db8a952ed6b6528122');
        expect(t40).toBe('32ce29bf77414f3db8a952ed6b65281214'); // 40 = "14" em base36
        for (const t of [t2, t3, t40, pixTxidForAttempt(PID, 46655)]) {
            expect(t).toMatch(TXID_RE);
            expect(t).not.toBe(toSicoobTxid(PID));
        }
        expect(new Set([t2, t3, t40]).size).toBe(3);
    });
    it('Cora: idempotency key por tentativa', () => {
        expect(pixIdempotencyKeyForAttempt(PID, 1)).toBe(PID);
        expect(pixIdempotencyKeyForAttempt(PID, 2)).toBe(`${PID}-2`);
    });
});

describe('nextPixAttempt / metadata', () => {
    it('nunca emitiu → 1', () => {
        expect(nextPixAttempt({ provider: 'SICOOB', providerRef: null, metadata: null })).toBe(1);
    });
    it('linha legada com cobrança e sem pixCharge → 2 (a 1ª consumiu o txid legado)', () => {
        expect(nextPixAttempt({ provider: 'SICOOB', providerRef: 'abc', metadata: null })).toBe(2);
    });
    it('usa o contador gravado', () => {
        expect(nextPixAttempt({ provider: 'SICOOB', providerRef: 'x', metadata: { pixCharge: { attempt: 3, amount: 1 } } })).toBe(4);
        // o contador sobrevive depois que o providerRef foi zerado (reset de FAILED / troca p/ cartão)
        expect(nextPixAttempt({ provider: 'STRIPE', providerRef: 'pi_1', metadata: { pixCharge: { attempt: 2 } } })).toBe(3);
    });
    it('pixMetadataAfterDiscard grava attempt=1 só em linha legada com cobrança PIX', () => {
        expect(pixMetadataAfterDiscard({ provider: 'SICOOB', providerRef: 'abc', metadata: { contractData: { a: 1 } } }))
            .toEqual({ contractData: { a: 1 }, pixCharge: { attempt: 1 } });
        expect(pixMetadataAfterDiscard({ provider: 'SICOOB', providerRef: 'abc', metadata: { pixCharge: { attempt: 2 } } })).toBeUndefined();
        expect(pixMetadataAfterDiscard({ provider: 'STRIPE', providerRef: 'pi_1', metadata: null })).toBeUndefined();
        expect(pixMetadataAfterDiscard({ provider: 'SICOOB', providerRef: null, metadata: null })).toBeUndefined();
    });
    it('mergePaymentMetadata preserva as outras chaves (contractData, installmentCap)', () => {
        expect(mergePaymentMetadata({ installmentCap: 3, contractData: { x: 1 } }, { pixCharge: { attempt: 1, amount: 10 } }))
            .toEqual({ installmentCap: 3, contractData: { x: 1 }, pixCharge: { attempt: 1, amount: 10 } });
        expect(mergePaymentMetadata(null, { a: 1 })).toEqual({ a: 1 });
        expect(readPixChargeMeta({ pixCharge: { attempt: 'x' } })).toBeNull();
    });
});

describe('isPixChargeReusable — reusa só se viva, válida e com o MESMO valor', () => {
    const now = new Date('2026-09-23T15:00:00Z');
    const emv = buildStaticBrCode({ key: 'k', amountCents: 84000 });
    const live = {
        status: 'PENDING', provider: 'SICOOB', providerRef: 'txid', pixString: emv,
        pixExpiresAt: new Date('2026-09-23T15:08:00Z'), amount: 84000,
        metadata: { pixCharge: { attempt: 1, amount: 84000 } },
    };
    it('cobrança viva e com o mesmo valor → reusa', () => expect(isPixChargeReusable(live, now)).toBe(true));
    it('expirada (ou com menos de 60s) → não', () => {
        expect(isPixChargeReusable({ ...live, pixExpiresAt: new Date('2026-09-23T14:59:00Z') }, now)).toBe(false);
        expect(isPixChargeReusable({ ...live, pixExpiresAt: new Date('2026-09-23T15:00:30Z') }, now)).toBe(false);
    });
    it('valor mudou (ex.: serviço editado) → não', () => {
        expect(isPixChargeReusable({ ...live, amount: 90000 }, now)).toBe(false);
    });
    it('legado sem pixExpiresAt ou sem valor gravado → não', () => {
        expect(isPixChargeReusable({ ...live, pixExpiresAt: null }, now)).toBe(false);
        expect(isPixChargeReusable({ ...live, metadata: null }, now)).toBe(false);
    });
    it('EMV inválido (lorem ipsum do sandbox) → não', () => {
        expect(isPixChargeReusable({ ...live, pixString: 'sunt elit' }, now)).toBe(false);
    });
    it('não PENDING, provedor de cartão ou sem providerRef → não', () => {
        expect(isPixChargeReusable({ ...live, status: 'PAID' }, now)).toBe(false);
        expect(isPixChargeReusable({ ...live, provider: 'STRIPE' }, now)).toBe(false);
        expect(isPixChargeReusable({ ...live, providerRef: null }, now)).toBe(false);
    });
});

describe('pixExpirySecondsFor — validade do QR', () => {
    const now = new Date('2026-09-23T15:00:00Z');
    it('avulso em espera → até o fim da reserva', () => {
        expect(pixExpirySecondsFor({ booking: { status: 'RESERVED', holdExpiresAt: new Date('2026-09-23T15:07:30Z') } }, now)).toBe(450);
    });
    it('reserva quase vencida → piso de 120s', () => {
        expect(pixExpirySecondsFor({ booking: { status: 'HELD', holdExpiresAt: new Date('2026-09-23T15:00:20Z') } }, now)).toBe(PIX_MIN_EXPIRES_SECONDS);
    });
    it('contrato aguardando pagamento → min(1h, prazo restante)', () => {
        const c = (iso: string) => ({ contract: { status: 'AWAITING_PAYMENT', paymentDeadline: new Date(iso) } });
        expect(pixExpirySecondsFor(c('2026-09-23T15:10:00Z'), now)).toBe(600); // serviço: 10 min
        expect(pixExpirySecondsFor(c('2026-09-26T15:00:00Z'), now)).toBe(PIX_DEFAULT_EXPIRES_SECONDS); // renovação: 3 dias → 1h
    });
    it('parcela comum (contrato ativo / sem prazo) → 1h', () => {
        expect(pixExpirySecondsFor({ contract: { status: 'ACTIVE', paymentDeadline: null } }, now)).toBe(3600);
        expect(pixExpirySecondsFor({ booking: { status: 'CONFIRMED', holdExpiresAt: null }, contract: null }, now)).toBe(3600);
    });
});

describe('desconto PIX do à vista nunca vale no cartão (D1 — pagamentos-3)', () => {
    it('buildPixDiscountMeta só marca quando o cartão custa mais que o PIX', () => {
        expect(buildPixDiscountMeta({ pixAmount: 283500, cardAmount: 315000, pct: 10 })).toEqual({ pct: 10, cardAmount: 315000, pixAmount: 283500 });
        expect(buildPixDiscountMeta({ pixAmount: 105000, cardAmount: 105000, pct: 10 })).toBeUndefined();
    });
    it('cobrança de valor ZERO (cupom 100% / VALOR ≥ total) nunca recebe marca', () => {
        expect(buildPixDiscountMeta({ pixAmount: 0, cardAmount: 31500, pct: 10 })).toBeUndefined();
        expect(buildPixDiscountMeta({ pixAmount: -1, cardAmount: 31500, pct: 10 })).toBeUndefined();
        // Cupom 100% sobre o à vista PIX (283500): amount 0 e cupom de R$ 2.835 → a "base do cartão" seria 31500.
        expect(pixDiscountMetaForCharge({ amount: 0, cardTotal: 315000, couponDiscount: 283500, pct: 10 })).toBeUndefined();
        // Cupom VALOR ≥ total (o desconto é limitado ao valor da cobrança): idem, com qualquer %.
        expect(pixDiscountMetaForCharge({ amount: 0, cardTotal: 315000, couponDiscount: 267750, pct: 15 })).toBeUndefined();
    });
    it('readPixDiscountMeta ignora lixo', () => {
        expect(readPixDiscountMeta({ pixDiscount: { pct: 10, cardAmount: 315000 }, installmentCap: 1 })).toEqual({ pct: 10, cardAmount: 315000 });
        expect(readPixDiscountMeta({ pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } })).toEqual({ pct: 10, cardAmount: 315000, pixAmount: 283500 });
        expect(readPixDiscountMeta({ pixDiscount: { cardAmount: 'x' } })).toBeNull();
        expect(readPixDiscountMeta({ pixDiscount: { cardAmount: 315000, pixAmount: 'x' } })).toBeNull(); // marca corrompida → sem reversão
        expect(readPixDiscountMeta(null)).toBeNull();
    });
    it('com a marca gravada na criação → cobra o cardAmount no cartão (nunca menos que o amount)', async () => {
        expect(await cardChargeBaseAmount({ amount: 283500, metadata: { pixDiscount: { pct: 10, cardAmount: 315000 } } })).toBe(315000);
        expect(await cardChargeBaseAmount({ amount: 283500, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } } })).toBe(315000);
        expect(await cardChargeBaseAmount({ amount: 283500, metadata: { pixDiscount: { pct: 10, cardAmount: 1000 } } })).toBe(283500);
    });
    it('marca CADUCA: o amount mudou depois da marca (pixAmount ≠ amount) → o próprio amount, nunca a base antiga', async () => {
        expect(await cardChargeBaseAmount({ amount: 200000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } } })).toBe(200000);
        expect(await cardChargeBaseAmount({ amount: 300000, metadata: { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } } })).toBe(300000);
    });
    it('valor ZERO nunca vai ao cartão: amount 0 com marca (inclusive a marca de R$ 315 do bug do cupom 100%) → 0', async () => {
        // Linha criada antes da correção pelo POST /contracts com cupom 100%: amount 0 e marca cardAmount 31500.
        expect(await cardChargeBaseAmount({ amount: 0, metadata: { pixDiscount: { pct: 10, cardAmount: 31500, pixAmount: 0 } } })).toBe(0);
        expect(await cardChargeBaseAmount({ amount: 0, metadata: { pixDiscount: { pct: 10, cardAmount: 31500 } } })).toBe(0);
        expect(await cardChargeBaseAmount({ amount: 0, metadata: null })).toBe(0);
    });
    it('pixDiscountMetaForCharge: base do cartão = total sem o desconto PIX − o mesmo cupom em R$; sem % → sem marca', () => {
        expect(pixDiscountMetaForCharge({ amount: 273500, cardTotal: 315000, couponDiscount: 10000, pct: 10 })).toEqual({ pct: 10, cardAmount: 305000, pixAmount: 273500 });
        expect(pixDiscountMetaForCharge({ amount: 283500, cardTotal: 315000, pct: 10 })).toEqual({ pct: 10, cardAmount: 315000, pixAmount: 283500 });
        expect(pixDiscountMetaForCharge({ amount: 315000, cardTotal: 315000, pct: 0 })).toBeUndefined();
    });
    it('SEM a marca → o próprio amount, qualquer que seja a linha (sem fallback legado, sem corte por data, sem ir ao banco)', async () => {
        dbCalls.length = 0;
        const fullPix = { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' };
        const old = new Date('2026-09-01T12:00:00Z');
        // Linha ANTIGA à vista FULL + PIX com origem PIX real (SICOOB, QR emitido). Decisão conservadora:
        // cobra o valor gravado (o preço PIX) — pode ficar ABAIXO do preço de cartão, NUNCA acima.
        expect(await cardChargeBaseAmount({
            id: 'p-old', amount: 283500, createdAt: old, contractId: 'c1', bookingId: null,
            metadata: { pixCharge: { attempt: 1, amount: 283500 } }, provider: 'SICOOB', pixString: '000201',
            status: 'PENDING', contract: fullPix,
        })).toBe(283500);
        // Idem com cupom (discountAmount): nada é recalculado pelo % configurado hoje.
        expect(await cardChargeBaseAmount({ id: 'p-old2', amount: 273500, discountAmount: 10000, createdAt: old, contractId: 'c1', metadata: null, contract: fullPix })).toBe(273500);
        // /self antigo (contrato só no contractData).
        expect(await cardChargeBaseAmount({ amount: 283500, createdAt: old, metadata: { contractData: fullPix } })).toBe(283500);
        // Linha criada hoje sem a marca (nunca teve desconto PIX).
        expect(await cardChargeBaseAmount({ id: 'p-new', amount: 315000, createdAt: new Date(), contractId: 'c1', bookingId: null, metadata: null })).toBe(315000);
        expect(dbCalls).toEqual([]);
    });
    it('sem marca e sem contrato FULL+PIX → o próprio amount', async () => {
        expect(await cardChargeBaseAmount({ amount: 84000, metadata: null, contract: { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'PIX' } })).toBe(84000);
        expect(await cardChargeBaseAmount({ amount: 84000, metadata: null, contract: { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'CARTAO' } })).toBe(84000);
    });
    it('extras (bookingId), multa e linha sem id de contrato FULL+PIX NUNCA são inflados', async () => {
        const fullPix = { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' };
        expect(await cardChargeBaseAmount({ id: 'p1', amount: 5000, contractId: 'c1', bookingId: 'b1', metadata: null, contract: fullPix })).toBe(5000);
        expect(await cardChargeBaseAmount({ amount: 31500, contractId: 'c1', bookingId: null, metadata: null, contract: fullPix })).toBe(31500);
    });
    it('o fallback legado e o corte por data não existem mais (regra única)', () => {
        const api = pixGateway as Record<string, unknown>;
        for (const gone of ['PIX_DISCOUNT_MARK_CUTOFF', 'legacyPixDiscountDecision', 'freezeLegacyPixDiscount', 'hasPixOrigin', 'freezeCardChargeBasesBeforeMethodChange']) {
            expect(api[gone], gone).toBeUndefined();
        }
    });
});

describe('paidChargedAmount — receita pelo valor efetivamente cobrado', () => {
    it('cartão (STRIPE ou ref pi_) → chargedAmount; PIX com chargedAmount de tentativa abandonada → amount', () => {
        expect(paidChargedAmount({ amount: 283500, chargedAmount: 315000, provider: 'STRIPE', providerRef: 'pi_1' })).toBe(315000);
        expect(paidChargedAmount({ amount: 90000, chargedAmount: 100000, provider: 'SICOOB', providerRef: 'pi_late' })).toBe(100000);
        expect(paidChargedAmount({ amount: 84000, chargedAmount: 99999, provider: 'SICOOB', providerRef: 'a'.repeat(32) })).toBe(84000);
        expect(paidChargedAmount({ amount: 84000, chargedAmount: null, provider: 'STRIPE', providerRef: 'pi_2' })).toBe(84000);
        expect(paidChargedAmount({ amount: 84000, provider: 'CORA', providerRef: 'inv_1' })).toBe(84000);
    });
});
