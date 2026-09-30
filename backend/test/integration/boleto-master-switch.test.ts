import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ─── Mocks dos provedores (Cora / Stripe / Sicoob): nenhuma chamada de rede real ─────────────────
vi.mock('../../src/lib/coraPaymentHelper', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraPaymentHelper')>();
    return { ...orig, createCoraPayment: vi.fn() };
});
vi.mock('../../src/lib/coraService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/coraService')>();
    return { ...orig, coraCreateBoleto: vi.fn(), coraCancelBoleto: vi.fn(async () => undefined), coraGetBoleto: vi.fn() };
});
vi.mock('../../src/lib/sicoobService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/sicoobService')>();
    return {
        ...orig,
        sicoobGetCob: vi.fn(),
        sicoobRemoveCob: vi.fn(async () => true),
        sicoobCreatePix: vi.fn(),
        getSicoobEnvironment: vi.fn(async () => 'sandbox'),
    };
});
vi.mock('../../src/lib/stripeService', async (importOriginal) => {
    const orig = await importOriginal<typeof import('../../src/lib/stripeService')>();
    return {
        ...orig,
        isStripeEnabled: vi.fn(async () => true),
        stripeCardInstallmentsSupported: vi.fn(async () => false),
        stripeGetPaymentIntent: vi.fn(),
        stripeCreatePaymentIntent: vi.fn(),
        stripeGetOrCreateCustomer: vi.fn(async () => 'cus_test'),
    };
});

import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import * as coraHelper from '../../src/lib/coraPaymentHelper';
import * as cora from '../../src/lib/coraService';
import * as sicoob from '../../src/lib/sicoobService';
import { buildStaticBrCode } from '../../src/lib/brcode';
import {
    getBoletoStatus, isBoletoAvailable, validatePaymentMethod, getAvailablePaymentMethods, createPayment as gatewayCreatePayment,
    boletoBlockedForPayment, PaymentMethodDisabledError, BoletoUnavailableError,
} from '../../src/lib/paymentGateway';
import { invalidateConfigCache } from '../../src/lib/businessConfig';
import contractRoutes from '../../src/modules/contracts/routes';
import stripeRoutes from '../../src/modules/stripe/routes';
import pricingRoutes from '../../src/modules/pricing/routes';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkContract, mkPayment, mkBooking, mkCpf } from './factories';

// E3 (decisão do dono, 30/09/2026) — boleto por CHAVE-MESTRA + Cora:
//  • chave-mestra = PaymentMethodConfig BOLETO.active ("Aceitar pagamento por boleto");
//  • boleto EFETIVO = chave ligada E integração Cora habilitada — fonte ÚNICA (getBoletoStatus) usada por
//    GET /pricing/payment-methods, validatePaymentMethod, create-payment, criação de contrato/agendamento
//    pelo admin e pelo gateway;
//  • ligar a chave sem a Cora ativa → 400; desligado → não aparece em lugar nenhum e o backend recusa;
//  • Contract.boletoAllowed deixa de ser autoridade;
//  • nunca em fluxos de reserva com prazo do cliente (avulso, /self, serviço, personalizado do cliente,
//    renovação) — só cobranças do admin e parcelas/faturas de contrato já ativo.

type Who = { id: string; email: string | null; role: string };
const m = <T extends (...a: any[]) => any>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/contracts', contractRoutes);
    app.use('/api/stripe', stripeRoutes);
    app.use('/api/pricing', pricingRoutes);
    app.use('/api/bookings', bookingRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
    vi.clearAllMocks();
    invalidateConfigCache();
    m(coraHelper.createCoraPayment).mockImplementation(async (req: { idempotencyKey?: string; amount: number }) => ({
        result: { id: `inv_${(req.idempotencyKey || 'x').slice(0, 8)}`, status: 'OPEN' },
        pixString: null,
        qrCodeBase64: null,
        boletoUrl: `https://cora.test/boleto/${req.idempotencyKey}.pdf`,
        barcode: '34191.79001 01043.510047 91020.150008 1 00000000000000',
    }));
    m(sicoob.getSicoobEnvironment).mockResolvedValue('sandbox');
    m(sicoob.sicoobRemoveCob).mockResolvedValue(true);
    m(sicoob.sicoobCreatePix).mockImplementation(async (p: { amount: number; txid: string; expiresSeconds?: number }) => ({
        id: p.txid,
        pixString: buildStaticBrCode({ key: 'k', amountCents: p.amount, txid: p.txid }),
        status: 'ATIVA',
        expiresAt: new Date(Date.now() + (p.expiresSeconds ?? 3600) * 1000),
    }));
});

function cookie(u: Who) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who?: Who, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            ...(who ? { Cookie: cookie(who) } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Métodos de pagamento + integrações. `boleto` = chave-mestra; `cora` = integração Cora habilitada. */
async function setup(opts: { boleto: boolean; cora: boolean }) {
    for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
        await prisma.paymentMethodConfig.create({
            data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: key === 'BOLETO' ? opts.boleto : true, sortOrder: i },
        });
    }
    await prisma.integrationConfig.create({ data: { provider: 'SICOOB', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'STRIPE', enabled: true, environment: 'sandbox', config: '{}' } });
    await prisma.integrationConfig.create({ data: { provider: 'CORA', enabled: opts.cora, environment: 'sandbox', config: '{}' } });
}

const todaySp = saoPauloParts(new Date()).dateStr;
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
function nextWeekday(wanted: number, minDays: number): string {
    for (let d = addDaysYmd(todaySp, minDays); ; d = addDaysYmd(d, 1)) if (dow(d) === wanted) return d;
}
const boletoRow = () => prisma.paymentMethodConfig.findUniqueOrThrow({ where: { key: 'BOLETO' } });

// ─── 1) Fonte única: getBoletoStatus / GET /pricing/payment-methods ──────────────────────────────
describe('E3 — estado do boleto (chave-mestra × Cora)', () => {
    const matrix = [
        { boleto: false, cora: false, available: false, reason: 'PROVIDER_DISABLED' },
        { boleto: true, cora: false, available: false, reason: 'PROVIDER_DISABLED' },
        { boleto: false, cora: true, available: false, reason: 'SWITCH_OFF' },
        { boleto: true, cora: true, available: true, reason: null },
    ] as const;

    for (const k of matrix) {
        it(`chave ${k.boleto ? 'LIGADA' : 'desligada'} + Cora ${k.cora ? 'ATIVA' : 'inativa'} → available=${k.available} (${k.reason ?? 'ok'})`, async () => {
            await setup(k);
            const status = await getBoletoStatus();
            expect(status).toMatchObject({ enabled: k.boleto, providerEnabled: k.cora, available: k.available, reason: k.reason });
            expect(status.message === null).toBe(k.available);
            expect(await isBoletoAvailable()).toBe(k.available);

            const pub = await call('GET', '/api/pricing/payment-methods');
            expect(pub.status).toBe(200);
            // SEC-3: a rota é PÚBLICA → boleto saneado (só `available` informa; chave, Cora e motivo ficam no /all do ADMIN).
            expect(pub.body.boleto).toEqual({ enabled: k.available, providerEnabled: k.available, available: k.available, reason: null, message: null });
            expect(pub.body.methods.map((x: any) => x.key)).toEqual(k.available ? ['PIX', 'CARTAO', 'BOLETO'] : ['PIX', 'CARTAO']);
            expect((await getAvailablePaymentMethods()).some(x => x.key === 'BOLETO')).toBe(k.available);

            if (k.available) await expect(validatePaymentMethod('BOLETO')).resolves.toBeUndefined();
            else await expect(validatePaymentMethod('BOLETO')).rejects.toBeInstanceOf(PaymentMethodDisabledError);

            const admin = await mkUser({ role: 'ADMIN' });
            const all = await call('GET', '/api/pricing/payment-methods/all', admin);
            expect(all.status).toBe(200);
            expect(all.body.methods.map((x: any) => x.key)).toEqual(['PIX', 'CARTAO', 'BOLETO']); // a tela de Configurações vê os três
            expect(all.body.boleto).toMatchObject({ enabled: k.boleto, available: k.available, reason: k.reason });
        });
    }

    it('dev sem NENHUMA integração cadastrada: o atalho de dev não libera o boleto (só PIX e Cartão)', async () => {
        for (const [i, key] of ['PIX', 'CARTAO', 'BOLETO'].entries()) {
            await prisma.paymentMethodConfig.create({ data: { key, label: key, shortLabel: key, emoji: '-', description: key, color: '#000000', active: true, sortOrder: i } });
        }
        expect((await getAvailablePaymentMethods()).map(x => x.key)).toEqual(['PIX', 'CARTAO']);
        expect(await getBoletoStatus()).toMatchObject({ enabled: true, available: false, reason: 'PROVIDER_DISABLED' });
    });

    it('banco sem métodos configurados: os padrões públicos não incluem boleto; a tela do admin semeia o boleto DESLIGADO', async () => {
        const pub = await call('GET', '/api/pricing/payment-methods');
        expect(pub.body.methods.map((x: any) => x.key)).toEqual(['PIX', 'CARTAO']);
        expect(pub.body.boleto).toMatchObject({ enabled: false, available: false });
        const admin = await mkUser({ role: 'ADMIN' });
        const all = await call('GET', '/api/pricing/payment-methods/all', admin);
        expect(all.body.methods.find((x: any) => x.key === 'BOLETO').active).toBe(false);
        expect((await boletoRow()).active).toBe(false);
    });

    it('gateway (parcelas pré-geradas): boleto indisponível em PRODUÇÃO é erro — nunca um boleto falso', async () => {
        await setup({ boleto: true, cora: false });
        const opts = { paymentMethod: 'BOLETO' as const, amount: 84000, description: 'x', customer: { name: 'C', email: 'c@x.com', cpf: mkCpf() }, dueDate: new Date(Date.now() + 86_400_000), paymentId: '11111111-1111-1111-1111-111111111111' };
        const dev = await gatewayCreatePayment(opts);
        expect(dev.provider).toBe('MOCK'); // dev/teste: mock, como o PIX
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            await expect(gatewayCreatePayment(opts)).rejects.toBeInstanceOf(BoletoUnavailableError);
        } finally {
            process.env.NODE_ENV = prev;
        }
        expect(cora.coraCreateBoleto).not.toHaveBeenCalled();
    });
});

// ─── 2) A chave-mestra nas Configurações ─────────────────────────────────────────────────────────
describe('E3 — ligar/desligar a chave "Aceitar pagamento por boleto"', () => {
    it('PUT /pricing/payment-methods/boleto: ligar sem a Cora → 400 BOLETO_PROVIDER_DISABLED (nada gravado); com a Cora → 200; desligar sempre', async () => {
        await setup({ boleto: false, cora: false });
        const admin = await mkUser({ role: 'ADMIN' });
        const denied = await call('PUT', '/api/pricing/payment-methods/boleto', admin, { enabled: true });
        expect(denied.status).toBe(400);
        expect(denied.body.code).toBe('BOLETO_PROVIDER_DISABLED');
        expect(denied.body.error).toMatch(/Cora/);
        expect(denied.body.boleto).toMatchObject({ enabled: false, available: false, reason: 'PROVIDER_DISABLED' });
        expect((await boletoRow()).active).toBe(false);

        await prisma.integrationConfig.update({ where: { provider: 'CORA' }, data: { enabled: true } });
        const on = await call('PUT', '/api/pricing/payment-methods/boleto', admin, { enabled: true });
        expect(on.status).toBe(200);
        expect(on.body.boleto).toMatchObject({ enabled: true, available: true, reason: null });
        expect((await boletoRow()).active).toBe(true);

        // A Cora foi desligada depois: a chave continua ligada, mas o boleto deixa de ser efetivo — e desligar é livre.
        await prisma.integrationConfig.update({ where: { provider: 'CORA' }, data: { enabled: false } });
        expect(await getBoletoStatus()).toMatchObject({ enabled: true, available: false, reason: 'PROVIDER_DISABLED' });
        const off = await call('PUT', '/api/pricing/payment-methods/boleto', admin, { enabled: false });
        expect(off.status).toBe(200);
        expect(off.body.boleto).toMatchObject({ enabled: false, available: false });
        expect((await boletoRow()).active).toBe(false);
    });

    it('só ADMIN; corpo inválido → 400', async () => {
        await setup({ boleto: false, cora: true });
        const client = await mkUser();
        expect((await call('PUT', '/api/pricing/payment-methods/boleto', client, { enabled: true })).status).toBe(403);
        expect((await call('PUT', '/api/pricing/payment-methods/boleto', undefined, { enabled: true })).status).toBe(401);
        const admin = await mkUser({ role: 'ADMIN' });
        expect((await call('PUT', '/api/pricing/payment-methods/boleto', admin, { enabled: 'sim' })).status).toBe(400);
        expect((await boletoRow()).active).toBe(false);
    });

    it('PUT /pricing/payment-methods (lote): ligar o boleto sem a Cora → 400 e NADA do lote é gravado; já ligado não bloqueia salvar os outros', async () => {
        await setup({ boleto: false, cora: false });
        const admin = await mkUser({ role: 'ADMIN' });
        const item = (key: string, active: boolean, label = key) => ({ key, label, shortLabel: key, emoji: '-', description: key, color: '#000000', active, sortOrder: 0, accessMode: 'FULL' });
        const denied = await call('PUT', '/api/pricing/payment-methods', admin, { methods: [item('PIX', true, 'PIX novo'), item('BOLETO', true)] });
        expect(denied.status).toBe(400);
        expect(denied.body.code).toBe('BOLETO_PROVIDER_DISABLED');
        expect((await prisma.paymentMethodConfig.findUniqueOrThrow({ where: { key: 'PIX' } })).label).toBe('PIX');
        expect((await boletoRow()).active).toBe(false);

        // Boleto desligado no lote → salva normalmente.
        const ok = await call('PUT', '/api/pricing/payment-methods', admin, { methods: [item('PIX', true, 'PIX novo'), item('BOLETO', false)] });
        expect(ok.status).toBe(200);
        expect(ok.body.boleto).toMatchObject({ enabled: false, available: false });
        expect((await prisma.paymentMethodConfig.findUniqueOrThrow({ where: { key: 'PIX' } })).label).toBe('PIX novo');

        // Chave que JÁ estava ligada (Cora desligada depois): o lote com boleto ativo não trava os demais.
        await prisma.paymentMethodConfig.update({ where: { key: 'BOLETO' }, data: { active: true } });
        const kept = await call('PUT', '/api/pricing/payment-methods', admin, { methods: [item('PIX', true, 'PIX 3'), item('BOLETO', true)] });
        expect(kept.status).toBe(200);
        expect(kept.body.boleto).toMatchObject({ enabled: true, available: false, reason: 'PROVIDER_DISABLED' });
    });
});

// ─── 3) create-payment (ramo boleto) ─────────────────────────────────────────────────────────────
describe('E3 — POST /stripe/create-payment { paymentMethod: "boleto" }', () => {
    async function installment(over: { contract?: Record<string, unknown>; payment?: Record<string, unknown> } = {}) {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const contract = await mkContract(client.id, { type: 'FIXO', paymentPlan: 'MONTHLY', paymentMethod: 'PIX', ...over.contract });
        const payment = await mkPayment(client.id, { contractId: contract.id, provider: 'SICOOB', amount: 84000, ...over.payment });
        return { admin, client, contract, payment };
    }
    const boleto = (who: Who, paymentId: string) => call('POST', '/api/stripe/create-payment', who, { paymentId, paymentMethod: 'boleto' });

    it('chave desligada → 400 BOLETO_UNAVAILABLE, mesmo com "Permitir boleto neste contrato" (boletoAllowed) marcado — admin e cliente', async () => {
        await setup({ boleto: false, cora: true });
        const { admin, client, payment } = await installment({ contract: { boletoAllowed: true } });
        for (const who of [client, admin]) {
            const r = await boleto(who, payment.id);
            expect(r.status).toBe(400);
            expect(r.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF' });
        }
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).boletoUrl).toBeNull();
    });

    it('chave ligada mas Cora inativa → 400 BOLETO_UNAVAILABLE (PROVIDER_DISABLED)', async () => {
        await setup({ boleto: true, cora: false });
        const { client, payment } = await installment({ contract: { boletoAllowed: true } });
        const r = await boleto(client, payment.id);
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'PROVIDER_DISABLED' });
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
    });

    it('efetivo: parcela de contrato ATIVO → boleto gerado SEM precisar de boletoAllowed; pagador = dono do pagamento (cliente e admin)', async () => {
        await setup({ boleto: true, cora: true });
        const { admin, client, payment } = await installment({ contract: { boletoAllowed: false } });
        const r = await boleto(client, payment.id);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ provider: 'CORA', paymentId: payment.id, amount: 84000 });
        expect(r.body.boletoUrl).toMatch(/^https:\/\/cora\.test\/boleto\//);
        expect(m(coraHelper.createCoraPayment).mock.calls[0]![0]).toMatchObject({ userId: client.id, amount: 84000, withPixQrCode: false, idempotencyKey: payment.id });
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ provider: 'CORA', amount: 84000, installments: 1 });

        // O admin cobrando o cliente: o boleto sai no CPF/nome do CLIENTE.
        const second = await installment();
        const byAdmin = await boleto(second.admin, second.payment.id);
        expect(byAdmin.status).toBe(200);
        expect(m(coraHelper.createCoraPayment).mock.calls[1]![0].userId).toBe(second.client.id);
        expect(admin.id).not.toBe(second.client.id);
    });

    it('contratação com PRAZO (contrato aguardando pagamento, /self sem contrato, reserva em espera) → 400 BOLETO_NOT_ALLOWED_HERE, também para o admin', async () => {
        await setup({ boleto: true, cora: true });
        const awaiting = await installment({ contract: { status: 'AWAITING_PAYMENT', paymentDeadline: new Date(Date.now() + 600_000) } });
        const self = await mkUser({ cpfCnpj: mkCpf() });
        const selfPayment = await mkPayment(self.id, { amount: 283500, metadata: { contractData: { type: 'FIXO', paymentPlan: 'FULL', paymentMethod: 'PIX' } } });
        const held = await installment({ contract: { type: 'AVULSO', paymentPlan: 'FULL' } });
        const heldBooking = await mkBooking(held.client.id, held.contract.id, { status: 'RESERVED', holdExpiresAt: new Date(Date.now() + 600_000) });
        await prisma.payment.update({ where: { id: held.payment.id }, data: { bookingId: heldBooking.id } });

        const cases: [Who, string][] = [
            [awaiting.client, awaiting.payment.id], [awaiting.admin, awaiting.payment.id],
            [self, selfPayment.id],
            [held.client, held.payment.id], [held.admin, held.payment.id],
        ];
        for (const [who, id] of cases) {
            const r = await boleto(who, id);
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('BOLETO_NOT_ALLOWED_HERE');
            expect(r.body.error).toMatch(/PIX ou cartão/);
        }
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();

        expect(boletoBlockedForPayment({ contractId: 'c', contract: { status: 'ACTIVE' }, booking: null })).toBeNull();
        expect(boletoBlockedForPayment({ contractId: 'c', contract: { status: 'COMPLETED' }, booking: { status: 'CONFIRMED', holdExpiresAt: null } })).toBeNull();
        expect(boletoBlockedForPayment({ contractId: 'c', contract: { status: 'CANCELLED' }, booking: null })).toBeNull(); // multa de cancelamento
        expect(boletoBlockedForPayment({ contractId: 'c', contract: { status: 'ACTIVE' }, booking: { status: 'HELD', holdExpiresAt: null } })).not.toBeNull();
    });

    it('E2: boleto cobra o preço de CARTÃO — cobrança à vista no preço PIX volta ao cardAmount antes de emitir; R$ 0 não gera boleto', async () => {
        await setup({ boleto: true, cora: true });
        const mark = { pixDiscount: { pct: 10, cardAmount: 315000, pixAmount: 283500 } };
        const { client, payment } = await installment({ contract: { paymentPlan: 'FULL' }, payment: { amount: 283500, metadata: mark } });
        const r = await boleto(client, payment.id);
        expect(r.status).toBe(200);
        expect(r.body.amount).toBe(315000);
        expect(m(coraHelper.createCoraPayment).mock.calls[0]![0].amount).toBe(315000);
        const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(after.amount).toBe(315000);
        expect((after.metadata as any).pixDiscount).toEqual(mark.pixDiscount);

        // Voltar ao PIX depois do boleto: o preço PIX da marca vale de novo (bidirecional).
        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
        expect(pix.body.amount).toBe(283500);

        const zero = await installment({ payment: { amount: 0 } });
        const z = await boleto(zero.client, zero.payment.id);
        expect(z.status).toBe(400);
        expect(m(coraHelper.createCoraPayment).mock.calls.length).toBe(1);
    });

    it('PIX e cartão NÃO dependem da chave do boleto', async () => {
        await setup({ boleto: false, cora: false });
        const { client, payment } = await installment();
        const pix = await call('POST', '/api/stripe/create-payment', client, { paymentId: payment.id, paymentMethod: 'pix' });
        expect(pix.status).toBe(200);
        expect(pix.body.amount).toBe(84000);
    });
});

// ─── 4) Criação pelo admin e fluxos do cliente ───────────────────────────────────────────────────
describe('E3 — criação de contrato/agendamento', () => {
    const fixoBody = (userId: string, paymentMethod: string) => ({
        userId, name: 'Fixo', type: 'FIXO', tier: 'COMERCIAL', durationMonths: 3,
        startDate: nextWeekday(1, 2), fixedDayOfWeek: 1, fixedTime: '13:00', paymentPlan: 'MONTHLY', paymentMethod,
    });

    it('admin POST /contracts com BOLETO: indisponível → 400 BOLETO_UNAVAILABLE e nada é criado; efetivo → 201 (boletoAllowed ignorado)', async () => {
        await setup({ boleto: true, cora: false });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const denied = await call('POST', '/api/contracts', admin, { ...fixoBody(client.id, 'BOLETO'), boletoAllowed: true });
        expect(denied.status).toBe(400);
        expect(denied.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'PROVIDER_DISABLED' });
        expect(await prisma.contract.count()).toBe(0);
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.payment.count()).toBe(0);

        await prisma.integrationConfig.update({ where: { provider: 'CORA' }, data: { enabled: true } });
        const ok = await call('POST', '/api/contracts', admin, fixoBody(client.id, 'BOLETO'));
        expect(ok.status).toBe(201);
        const rows = await prisma.payment.findMany({ where: { contractId: ok.body.contract.id } });
        expect(rows.length).toBe(3);
        expect(rows.every(r => r.provider === 'CORA' && r.status === 'PENDING')).toBe(true);
        // O cliente paga a parcela do contrato ATIVO por boleto sem liberação por contrato.
        const pay = await call('POST', '/api/stripe/create-payment', client, { paymentId: ok.body.firstPaymentId, paymentMethod: 'boleto' });
        expect(pay.status).toBe(200);

        // PIX/cartão do admin não passam pela chave do boleto.
        await prisma.paymentMethodConfig.update({ where: { key: 'BOLETO' }, data: { active: false } });
        const other = await mkUser();
        expect((await call('POST', '/api/contracts', admin, { ...fixoBody(other.id, 'PIX'), fixedTime: '15:30' })).status).toBe(201);
    });

    it('cliente: /self, /service, /custom e renovação NUNCA aceitam boleto (mesmo efetivo) → 400 BOLETO_NOT_ALLOWED_HERE, nada criado', async () => {
        await setup({ boleto: true, cora: true });
        await prisma.addOnConfig.create({ data: { key: 'GESTAO_TRAFEGO', name: 'Gestão de Tráfego', price: 150000, monthly: true, plansAllowed: 'FULL,MONTHLY', durationsOffered: '3,6' } });
        const client = await mkUser({ cpfCnpj: mkCpf() });

        const self = await call('POST', '/api/contracts/self', client, {
            name: 'Flex', type: 'FLEX', tier: 'COMERCIAL', durationMonths: 3,
            firstBookingDate: nextWeekday(3, 3), firstBookingTime: '13:00', paymentMethod: 'BOLETO', paymentPlan: 'MONTHLY',
        });
        const service = await call('POST', '/api/contracts/service', client, { serviceKey: 'GESTAO_TRAFEGO', paymentMethod: 'BOLETO', durationMonths: 3, paymentPlan: 'MONTHLY' });
        const tomorrow = addDaysYmd(todaySp, 1);
        const custom = await call('POST', '/api/contracts/custom', client, {
            name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'BOLETO', paymentPlan: 'MONTHLY',
            schedule: [{ day: 2, time: '10:00' }], startDate: tomorrow,
        });
        const active = await mkContract(client.id, { type: 'FLEX', endDate: new Date(Date.now() + 3 * 86_400_000) });
        const renew = await call('POST', `/api/contracts/${active.id}/client-renew`, client, { durationMonths: 3, paymentMethod: 'BOLETO' });

        for (const r of [self, service, custom, renew]) {
            expect(r.status).toBe(400);
            expect(r.body.code).toBe('BOLETO_NOT_ALLOWED_HERE');
        }
        expect(await prisma.payment.count()).toBe(0);
        expect(await prisma.contract.count()).toBe(1); // só o contrato ativo de antes
        expect(coraHelper.createCoraPayment).not.toHaveBeenCalled();
        expect(cora.coraCreateBoleto).not.toHaveBeenCalled();
    });

    it('admin /custom com BOLETO: efetivo → 201; chave desligada → 400', async () => {
        await setup({ boleto: true, cora: true });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const body = {
            userId: client.id, name: 'Personalizado', tier: 'COMERCIAL', durationMonths: 1, paymentMethod: 'BOLETO', paymentPlan: 'MONTHLY',
            schedule: [{ day: 2, time: '10:00' }], startDate: nextWeekday(2, 2),
        };
        const ok = await call('POST', '/api/contracts/custom', admin, body);
        expect(ok.status).toBe(201);
        expect(ok.body.status).toBe('ACTIVE');

        await prisma.paymentMethodConfig.update({ where: { key: 'BOLETO' }, data: { active: false } });
        const denied = await call('POST', '/api/contracts/custom', admin, { ...body, schedule: [{ day: 3, time: '10:00' }], startDate: nextWeekday(3, 2) });
        expect(denied.status).toBe(400);
        expect(await prisma.contract.count()).toBe(1);
    });

    it('admin POST /bookings/admin com BOLETO: indisponível → 400 sem criar o agendamento; efetivo → 201 com o boleto do CLIENTE', async () => {
        await setup({ boleto: false, cora: true });
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser({ cpfCnpj: mkCpf() });
        const day = nextWeekday(2, 3);
        const denied = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: day, startTime: '10:00', status: 'RESERVED', paymentMethod: 'BOLETO' });
        expect(denied.status).toBe(400);
        expect(denied.body).toMatchObject({ code: 'BOLETO_UNAVAILABLE', reason: 'SWITCH_OFF' });
        expect(await prisma.booking.count()).toBe(0);
        expect(await prisma.contract.count()).toBe(0);

        await prisma.paymentMethodConfig.update({ where: { key: 'BOLETO' }, data: { active: true } });
        const ok = await call('POST', '/api/bookings/admin', admin, { userId: client.id, date: day, startTime: '10:00', status: 'RESERVED', paymentMethod: 'BOLETO' });
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.boletoUrl).toMatch(/^https:\/\/cora\.test\/boleto\//);
        expect(m(coraHelper.createCoraPayment).mock.calls[0]![0]).toMatchObject({ userId: client.id, withPixQrCode: false });
        expect(await prisma.payment.findUniqueOrThrow({ where: { id: ok.body.paymentId } })).toMatchObject({ provider: 'CORA', status: 'PENDING' });
    });
});
