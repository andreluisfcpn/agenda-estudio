import { ContractWithStats, Contract, MakeupStatus } from '../api/client';

// ─── Avulso ──────────────────────────────────────────────

/**
 * O contrato é um AVULSO (micro-contrato de uma única gravação)?
 * Mesma regra de ContractCard.tsx: tipo AVULSO, ou o legado FLEX com durationMonths 1.
 */
export function isAvulsoContract(c: { type: string; durationMonths?: number | null }): boolean {
    return c.type === 'AVULSO' || (c.type === 'FLEX' && c.durationMonths === 1);
}

/**
 * A reserva tem a janela de remarcação (falta justificada / Não Realizado do avulso — D4/D5)
 * ABERTA agora? OPEN e prazo ainda não vencido (otimista: se o job ainda não expirou, o
 * prazo passado já conta como fechado). Sem prazo informado, confia no status.
 */
export function isBookingMakeupOpen(
    b: { makeupStatus?: MakeupStatus | string | null; makeupDeadline?: string | null },
    now: Date = new Date(),
): boolean {
    if (b.makeupStatus !== 'OPEN') return false;
    if (!b.makeupDeadline) return true;
    return new Date(b.makeupDeadline).getTime() > now.getTime();
}

// ─── Termos do contrato (vigência / duração / plano) ─────

/** Reserva mínima para descrever a vigência do avulso. */
export interface TermsBooking {
    date: string; startTime: string; endTime?: string | null; status: string;
}
/** Pagamento mínimo para descrever o plano (parcelas no cartão). */
export interface TermsPayment {
    status: string; installments?: number | null;
}
export interface ContractTerms {
    /** AVULSO: "15 de set. de 2026 · 10:00–12:00"; demais: "15 de set. de 2026 – 15 de dez. de 2026". */
    vigencia: string;
    /** AVULSO: "Sessão única"; demais: "3 meses · 30% fidelidade" / "1 mês · sem desconto". */
    duracao: string;
    /** Rótulo sugerido para o campo de duração ("Duração" no avulso, "Duração / Desconto" nos demais). */
    duracaoLabel: string;
    /** AVULSO: "Pagamento único" (+ " · cartão em 3x"); FULL: "Integral (à vista)"; MONTHLY: "Mensal (3x)". */
    plano: string;
    isAvulso: boolean;
}
export interface ContractTermsOptions {
    /** 'long' (padrão) = "15 de set. de 2026" (detalhe); 'short' = "15/09/2026" (tabelas/listas). */
    dateFormat?: 'long' | 'short';
}

type TermsContract = Pick<Contract, 'type' | 'durationMonths' | 'discountPct' | 'startDate' | 'endDate'> & {
    paymentPlan?: Contract['paymentPlan'] | string | null;
};

/** Datas @db.Date chegam como ISO à meia-noite UTC — formatar SEMPRE em UTC (senão volta 1 dia). */
function fmtContractDate(iso: string, format: 'long' | 'short'): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return format === 'short'
        ? d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
        : d.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
}

/** Pagamento que representa o plano: o PAGO, senão o primeiro não cancelado, senão o primeiro. */
function representativePayment(payments?: TermsPayment[] | null): TermsPayment | undefined {
    if (!payments || payments.length === 0) return undefined;
    return payments.find(p => p.status === 'PAID')
        ?? payments.find(p => p.status !== 'CANCELLED' && p.status !== 'REFUNDED')
        ?? payments[0];
}

function cardInstallmentsSuffix(payments?: TermsPayment[] | null): string {
    const n = representativePayment(payments)?.installments ?? 1;
    return n > 1 ? ` · cartão em ${n}x` : '';
}

/**
 * Descreve vigência, duração e plano do contrato de forma coerente com o TIPO — o avulso é
 * criado com durationMonths 1 / endDate = data + 30 dias / paymentPlan MONTHLY (defaults
 * herdados), que não têm significado para uma sessão única; por isso ele é derivado da reserva.
 *
 * - AVULSO (ou FLEX legado de 1 mês): vigência = data da gravação NÃO cancelada + horário
 *   (a remarcação muda a reserva, não o contrato; fallback startDate), duração "Sessão única",
 *   plano "Pagamento único" (+ " · cartão em Nx" quando parcelado).
 * - Demais: "início – fim", "N mês/meses · X% fidelidade" (ou "· sem desconto"),
 *   FULL "Integral (à vista)" (+ " · cartão em Nx" quando o pagamento integral foi parcelado —
 *   serviço D1), MONTHLY (ou ausente) "Mensal (Nx)".
 */
export function describeContractTerms(
    c: TermsContract,
    bookings?: TermsBooking[] | null,
    payments?: TermsPayment[] | null,
    opts: ContractTermsOptions = {},
): ContractTerms {
    const format = opts.dateFormat ?? 'long';

    if (isAvulsoContract(c)) {
        const live = (bookings || [])
            .filter(b => b.status !== 'CANCELLED')
            .sort((a, b) => (a.date.slice(0, 10) + a.startTime).localeCompare(b.date.slice(0, 10) + b.startTime));
        const session = live[live.length - 1];
        const vigencia = session
            ? `${fmtContractDate(session.date, format)} · ${session.startTime}${session.endTime ? `–${session.endTime}` : ''}`
            : fmtContractDate(c.startDate, format);
        return {
            vigencia,
            duracao: 'Sessão única',
            duracaoLabel: 'Duração',
            plano: `Pagamento único${cardInstallmentsSuffix(payments)}`,
            isAvulso: true,
        };
    }

    const n = c.durationMonths;
    const pct = c.discountPct || 0;
    const duracao = `${n} ${n === 1 ? 'mês' : 'meses'} · ${pct > 0 ? `${pct}% fidelidade` : 'sem desconto'}`;
    const plano = c.paymentPlan === 'FULL'
        ? (() => {
            const suffix = cardInstallmentsSuffix(payments);
            return suffix ? `Integral${suffix}` : 'Integral (à vista)';
        })()
        : `Mensal (${n}x)`;

    return {
        vigencia: `${fmtContractDate(c.startDate, format)} – ${fmtContractDate(c.endDate, format)}`,
        duracao,
        duracaoLabel: 'Duração / Desconto',
        plano,
        isAvulso: false,
    };
}

// ─── Contrato "atual" (aba Ativos / KPI do cliente) ──────

/**
 * O contrato conta como "ativo" para o CLIENTE? (mesma regra da aba "Ativos"
 * de MyContractsPage — extraída para o KPI do dashboard não divergir: status
 * ACTIVE no banco com todas as sessões consumidas é "finalizado" para o
 * usuário, não "ativo").
 * - COMPLETED ("Concluído", D6) nunca é atual.
 * - AVULSO com remarcação aberta (makeupStatus OPEN, prazo não vencido) é atual: o cliente
 *   ainda tem uma gravação a remarcar.
 */
export function isContractCurrent(c: ContractWithStats): boolean {
    if (c.status === 'CANCELLED' || c.status === 'EXPIRED' || c.status === 'COMPLETED') return false;

    // Optimistically filter out expired pending contracts before the cleanup cron job runs
    if (c.status === 'AWAITING_PAYMENT' && c.paymentDeadline && new Date(c.paymentDeadline).getTime() <= Date.now()) return false;

    if (c.status !== 'ACTIVE' && c.status !== 'PENDING_CANCELLATION' && c.status !== 'PAUSED' && c.status !== 'AWAITING_PAYMENT') return false;
    if (c.status === 'AWAITING_PAYMENT') return true;

    const bookings = c.bookings || [];
    if (isAvulsoContract(c) && bookings.some(b => isBookingMakeupOpen(b))) return true;

    const totalBookings = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
    const usedBookingsCount = c.type === 'FIXO'
        ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length
        : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);

    const now = new Date();
    const hasPending = bookings.some(b => {
        if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
        const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
        return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
    });

    if (hasPending) return true;
    if (c.status === 'PENDING_CANCELLATION') return true;

    return totalBookings === 0 || (totalBookings != null && usedBookingsCount < totalBookings);
}
