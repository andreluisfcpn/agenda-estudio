import { describe, it, expect, vi } from 'vitest';

// Teste UNITÁRIO das regras puras da multa de cancelamento (E13): nada aqui vai ao banco.
vi.mock('../src/lib/prisma', () => {
    const model = (name: string) => new Proxy({}, {
        get: (_t, op) => () => Promise.reject(new Error(`acesso ao banco num teste unitário: ${name}.${String(op)}`)),
    });
    return { prisma: new Proxy({}, { get: (_t, name) => model(String(name)) }) };
});

import {
    CANCELLATION_FINE_KIND, computeFineAmount, isCancellationFine, isUnpaidPlanInstallment,
    paymentKind, remainingPlanAmount, effectiveFineBase, effectiveCancellationBasis,
} from '../src/lib/cancellationFine';

const fineMeta = { kind: CANCELLATION_FINE_KIND, finePct: 20, baseAmount: 168000 };

describe('paymentKind / isCancellationFine', () => {
    it('lê metadata.kind; sem metadata, array ou kind vazio → null', () => {
        expect(paymentKind(fineMeta)).toBe('CANCELLATION_FINE');
        expect(paymentKind(null)).toBeNull();
        expect(paymentKind(undefined)).toBeNull();
        expect(paymentKind([{ kind: 'CANCELLATION_FINE' }])).toBeNull();
        expect(paymentKind({ kind: '' })).toBeNull();
        expect(paymentKind({ kind: 42 })).toBeNull();
        expect(paymentKind({ pixDiscount: { pct: 10, cardAmount: 100 } })).toBeNull();
    });
    it('só a marca CANCELLATION_FINE identifica a multa (convive com outras chaves do metadata)', () => {
        expect(isCancellationFine({ metadata: fineMeta })).toBe(true);
        expect(isCancellationFine({ metadata: { ...fineMeta, pixCharge: { attempt: 1, amount: 33600 } } })).toBe(true);
        expect(isCancellationFine({ metadata: { kind: 'OUTRA' } })).toBe(false);
        expect(isCancellationFine({ metadata: null })).toBe(false);
        expect(isCancellationFine(null)).toBe(false);
    });
});

describe('computeFineAmount', () => {
    it('pct% da base, arredondado ao centavo', () => {
        expect(computeFineAmount(168000, 20)).toBe(33600);
        expect(computeFineAmount(84000, 20)).toBe(16800);
        expect(computeFineAmount(33333, 20)).toBe(6667); // 6666,6 → 6667
        expect(computeFineAmount(100001, 12.5)).toBe(12500); // 12500,125 → 12500
    });
    it('base ou % não positivos / inválidos → 0 (à vista quitado não tem multa)', () => {
        expect(computeFineAmount(0, 20)).toBe(0);
        expect(computeFineAmount(-100, 20)).toBe(0);
        expect(computeFineAmount(168000, 0)).toBe(0);
        expect(computeFineAmount(168000, -5)).toBe(0);
        expect(computeFineAmount(Number.NaN, 20)).toBe(0);
        expect(computeFineAmount(168000, Number.NaN)).toBe(0);
    });
});

describe('base da multa = parcelas do PLANO ainda não pagas', () => {
    const p = (over: Record<string, unknown>) => ({ amount: 84000, status: 'PENDING', bookingId: null, metadata: null, ...over });

    it('PENDING e FAILED do plano contam; PAID / CANCELLED / REFUNDED não', () => {
        expect(isUnpaidPlanInstallment(p({}))).toBe(true);
        expect(isUnpaidPlanInstallment(p({ status: 'FAILED' }))).toBe(true);
        for (const status of ['PAID', 'CANCELLED', 'REFUNDED']) expect(isUnpaidPlanInstallment(p({ status }))).toBe(false);
    });
    it('extras de uma gravação (bookingId) e a própria multa ficam fora', () => {
        expect(isUnpaidPlanInstallment(p({ bookingId: 'b1', amount: 5000 }))).toBe(false);
        expect(isUnpaidPlanInstallment(p({ metadata: fineMeta, amount: 33600 }))).toBe(false);
    });
    it('soma só o que falta pagar do plano', () => {
        expect(remainingPlanAmount([
            p({ status: 'PAID' }),                         // 1ª parcela paga
            p({}),                                         // 2ª pendente
            p({ status: 'FAILED' }),                       // 3ª recusada (ainda devida)
            p({ bookingId: 'b1', amount: 5000 }),          // extra de gravação
            p({ metadata: fineMeta, amount: 33600 }),      // multa antiga
            p({ status: 'CANCELLED' }),
        ])).toBe(168000);
        expect(remainingPlanAmount([p({ status: 'PAID', amount: 252000 })])).toBe(0); // à vista quitado
        expect(remainingPlanAmount([])).toBe(0);
    });
});

describe('base EFETIVA = mínimo entre a congelada no pedido e o que ainda falta pagar', () => {
    const row = (id: string, over: Record<string, unknown> = {}) => ({ id, amount: 84000, status: 'PENDING', bookingId: null, metadata: null, ...over });
    const frozen3 = { baseAmount: 252000, installments: [{ id: 'a', amount: 84000 }, { id: 'b', amount: 84000 }, { id: 'c', amount: 84000 }] };

    it('nada mudou desde o pedido → a base congelada', () => {
        expect(effectiveFineBase(frozen3, [row('a'), row('b'), row('c')])).toBe(252000);
    });
    it('parcela da base paga (ou reembolsada / apagada) depois do pedido sai da base', () => {
        expect(effectiveFineBase(frozen3, [row('a', { status: 'PAID' }), row('b'), row('c')])).toBe(168000);
        expect(effectiveFineBase(frozen3, [row('a', { status: 'PAID' }), row('b', { status: 'REFUNDED' }), row('c')])).toBe(84000);
        expect(effectiveFineBase(frozen3, [row('b'), row('c')])).toBe(168000);
        expect(effectiveFineBase(frozen3, [row('a', { status: 'PAID' }), row('b', { status: 'PAID' }), row('c', { status: 'PAID' })])).toBe(0);
    });
    it('FAILED continua devida; CANCELLED (anulada pelo próprio cancelamento) continua contando', () => {
        expect(effectiveFineBase(frozen3, [row('a', { status: 'FAILED' }), row('b', { status: 'CANCELLED' }), row('c', { status: 'CANCELLED' })])).toBe(252000);
        expect(effectiveFineBase(frozen3, [row('a', { status: 'PAID' }), row('b', { status: 'CANCELLED' }), row('c', { status: 'CANCELLED' })])).toBe(168000);
    });
    it('a base nunca aumenta: parcela nova e valor maior ficam de fora; valor menor entra', () => {
        expect(effectiveFineBase(frozen3, [row('a'), row('b'), row('c'), row('nova')])).toBe(252000);
        expect(effectiveFineBase(frozen3, [row('a', { amount: 100000 }), row('b'), row('c')])).toBe(252000);
        expect(effectiveFineBase(frozen3, [row('a', { amount: 70000 }), row('b'), row('c')])).toBe(238000);
        // paga uma da base, com parcela nova em aberto: a nova não "repõe" a que foi paga
        expect(effectiveFineBase(frozen3, [row('a', { status: 'PAID' }), row('b'), row('c'), row('nova')])).toBe(168000);
    });
    it('marca antiga (sem a lista): mínimo entre a congelada e o saldo do plano de hoje', () => {
        const legacy = { baseAmount: 252000, installments: null };
        expect(effectiveFineBase(legacy, [row('a'), row('b'), row('c')])).toBe(252000);
        expect(effectiveFineBase(legacy, [row('a', { status: 'PAID' }), row('b'), row('c')])).toBe(168000);
        expect(effectiveFineBase(legacy, [row('a'), row('b'), row('c'), row('nova')])).toBe(252000);
        // extras de gravação e a multa não entram no saldo
        expect(effectiveFineBase(legacy, [row('a', { status: 'PAID' }), row('b'), row('x', { bookingId: 'bk', amount: 5000 }), row('m', { metadata: fineMeta })])).toBe(84000);
        // na decisão: as que estavam em aberto antes de anular (voidedIds) ainda contam depois de anuladas
        const voided = [row('a', { status: 'PAID' }), row('b', { status: 'CANCELLED' }), row('c', { status: 'CANCELLED' })];
        expect(effectiveFineBase(legacy, voided)).toBe(0);
        expect(effectiveFineBase(legacy, voided, new Set(['b', 'c']))).toBe(168000);
    });
    it('effectiveCancellationBasis: % congelado, multa recalculada e a base do pedido preservada', () => {
        const snapshot = { requestedAt: new Date(), baseAmount: 252000, finePct: 20, fineAmount: 50400, frozen: true, installments: frozen3.installments };
        expect(effectiveCancellationBasis(snapshot, [row('a', { status: 'PAID' }), row('b'), row('c')]))
            .toMatchObject({ baseAmount: 168000, finePct: 20, fineAmount: 33600, frozenBaseAmount: 252000 });
        expect(effectiveCancellationBasis(snapshot, [row('a', { status: 'PAID' }), row('b', { status: 'PAID' }), row('c', { status: 'PAID' })]))
            .toMatchObject({ baseAmount: 0, fineAmount: 0, frozenBaseAmount: 252000 });
    });
});
