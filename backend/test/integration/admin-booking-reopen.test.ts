import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/config/index';
import { saoPauloParts } from '../../src/lib/spTime';
import { addDaysYmd } from '../../src/lib/avulsoMakeup';
import bookingRoutes from '../../src/modules/bookings/routes';
import { mkUser, mkContract, mkBooking } from './factories';

// regressoes-5 (D6): o "Novo Agendamento" do admin volta a listar planos FIXO/FLEX/CUSTOM "Concluídos"
// (COMPLETED, não avulso, na vigência). Este teste garante o lado do backend de que a UI depende:
// POST /api/bookings/admin vinculado a um contrato COMPLETED cria a sessão com o desconto do plano e
// REABRE o contrato (ACTIVE + auditoria REOPENED, via syncContractCompletion).

let server: Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/bookings', bookingRoutes);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function cookie(u: { id: string; email: string | null; role: string }) {
    return `accessToken=${jwt.sign({ userId: u.id, email: u.email ?? '', role: u.role }, config.jwt.secret, { expiresIn: '1h' })}`;
}

async function call(method: string, path: string, who: { id: string; email: string | null; role: string }, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { Cookie: cookie(who), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const todaySp = saoPauloParts(new Date()).dateStr;
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
/** 1º dia útil (seg–sex, faixa COMERCIAL) a partir de `from`. */
function nextWeekday(from: string): string {
    for (let d = from; ; d = addDaysYmd(d, 1)) if (dow(d) >= 1 && dow(d) <= 5) return d;
}

describe('POST /api/bookings/admin — vincular a um plano "Concluído" (D6 / regressoes-5)', () => {
    it('FIXO COMPLETED (todas as sessões feitas, vigência em curso): cria a sessão com o desconto do plano e reabre o contrato', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const target = nextWeekday(addDaysYmd(todaySp, 2));
        const contract = await mkContract(client.id, {
            type: 'FIXO', durationMonths: 1, discountPct: 30, status: 'COMPLETED',
            startDate: dbDate(addDaysYmd(todaySp, -30)), endDate: dbDate(addDaysYmd(todaySp, 20)),
            fixedDayOfWeek: dow(target), fixedTime: '10:00',
        });
        // 1 mês × 4 sessões/mês, todas gravadas → nada pendente (por isso COMPLETED antes do fim da vigência).
        for (let i = 1; i <= 4; i++) {
            await mkBooking(client.id, contract.id, {
                date: dbDate(addDaysYmd(todaySp, -7 * i)), startTime: '10:00', endTime: '12:00', status: 'COMPLETED',
            });
        }

        const res = await call('POST', '/api/bookings/admin', admin, {
            userId: client.id, contractId: contract.id, date: target, startTime: '10:00', status: 'CONFIRMED',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
        expect(after.status).toBe('ACTIVE');

        const booking = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.booking.id } });
        expect(booking.contractId).toBe(contract.id);
        expect(booking.status).toBe('CONFIRMED');

        const audit = await prisma.auditLog.findMany({ where: { entityType: 'CONTRACT', entityId: contract.id, action: 'REOPENED' } });
        expect(audit).toHaveLength(1);
        expect(audit[0].performedBy).toBe(admin.id);
    });

    it('contrato ACTIVE continua ACTIVE (sem auditoria de reabertura)', async () => {
        const admin = await mkUser({ role: 'ADMIN' });
        const client = await mkUser();
        const target = nextWeekday(addDaysYmd(todaySp, 2));
        const contract = await mkContract(client.id, {
            type: 'FIXO', durationMonths: 3, status: 'ACTIVE',
            startDate: dbDate(addDaysYmd(todaySp, -10)), endDate: dbDate(addDaysYmd(todaySp, 80)),
            fixedDayOfWeek: dow(target), fixedTime: '10:00',
        });

        const res = await call('POST', '/api/bookings/admin', admin, {
            userId: client.id, contractId: contract.id, date: target, startTime: '10:00', status: 'CONFIRMED',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('ACTIVE');
        expect(await prisma.auditLog.count({ where: { entityId: contract.id, action: 'REOPENED' } })).toBe(0);
    });
});
