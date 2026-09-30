/**
 * CSV da página Relatórios (E6) — função PURA: recebe os dados já carregados e devolve o texto do
 * arquivo. Sem DOM, sem fetch, sem relógio implícito (o "gerado em" vem por parâmetro), para poder
 * ser conferida por script (ver docs/tecnico/design-system.md → "Relatórios exportados").
 *
 * Formato pensado para o Excel pt-BR:
 *  - BOM UTF-8 (acentos corretos ao abrir com duplo clique), separador `;` e quebra CRLF;
 *  - NÃO usa a linha `sep=;` — ela faz o Excel ignorar o BOM e quebra os acentos;
 *  - campos com `;`, aspas ou quebra de linha vão entre aspas, com as aspas internas duplicadas;
 *  - texto livre (nome de cliente) que começa com = + - @ TAB ou CR ganha um apóstrofo na frente,
 *    para o Excel não interpretar como fórmula (CSV injection);
 *  - cabeçalho informativo em linhas próprias, uma seção por bloco (título + colunas + linhas +
 *    TOTAL), moeda "R$ 1.234,56", percentual "85%" e datas dd/mm/aaaa.
 */
import type {
    ReportSummary, SlotOccupancy, DayOccupancy, TierBreakdownItem, AudienceMetrics, ClientRankItem,
} from '../api/client';

export const REPORT_CSV_SEPARATOR = ';';
export const REPORT_CSV_EOL = '\r\n';
export const REPORT_CSV_BOM = '﻿';
export const REPORT_CSV_STUDIO = 'Estúdio Búzios Digital';
export const REPORT_CSV_TITLE = 'Relatório de desempenho — sessões, ocupação, faixas, audiência e ranking de clientes';

const DEFAULT_TIER_LABELS: Record<string, string> = {
    COMERCIAL: 'Comercial',
    AUDIENCIA: 'Audiência',
    SABADO: 'Sábado',
};

export interface ReportCsvInput {
    /** Primeiro dia do período, `AAAA-MM-DD` (inclusive). */
    from: string;
    /** Último dia do período, `AAAA-MM-DD` (inclusive). */
    to: string;
    /** Rótulo do filtro escolhido na tela (ex.: "Últimos 30 dias"). */
    periodLabel?: string;
    /** Momento da exportação (o chamador passa `new Date()`). */
    generatedAt: Date;
    /** Nome do estúdio no cabeçalho (padrão: Estúdio Búzios Digital). */
    studioName?: string;
    summary: ReportSummary;
    slotOccupancy: SlotOccupancy[];
    dayOccupancy: DayOccupancy[];
    tierBreakdown: TierBreakdownItem[];
    audience: AudienceMetrics | null;
    /** Ranking COMPLETO do período (não só o top 10 exibido na tela), já ordenado por receita. */
    ranking: ClientRankItem[];
    /** Rótulos das faixas (chave → nome legível). Desconhecida → a própria chave, sem `_`. */
    tierLabels?: Record<string, string>;
}

type Cell = string | number | null | undefined;

const NEEDS_QUOTES = /[;"\r\n]/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** Escapa UM campo (RFC 4180 com `;`): aspas quando há `;`, aspas, quebra de linha ou espaço nas pontas. */
export function csvCell(value: Cell): string {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
    if (NEEDS_QUOTES.test(s) || s !== s.trim()) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/**
 * Texto livre vindo do usuário (nome de cliente): neutraliza fórmula do Excel com um apóstrofo.
 * Use só em texto — número negativo tem de continuar número.
 */
export function csvText(value: string | null | undefined): string {
    const s = (value ?? '').replace(/\r\n?/g, '\n');
    return FORMULA_START.test(s) ? `'${s}` : s;
}

/** Uma linha do arquivo (campos já escapados e unidos por `;`). */
export function csvRow(cells: Cell[]): string {
    return cells.map(csvCell).join(REPORT_CSV_SEPARATOR);
}

/** Centavos → "R$ 1.234,56" (espaço comum: o Excel pt-BR lê como moeda). */
export function csvMoney(cents: number): string {
    const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
    const abs = Math.abs(safe);
    const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const centavos = String(abs % 100).padStart(2, '0');
    return `${safe < 0 ? '-' : ''}R$ ${reais},${centavos}`;
}

/** Contagem inteira SEM separador de milhar ("1530"): numérica em qualquer planilha, sem ambiguidade. */
export function csvInt(n: number): string {
    return String(Number.isFinite(n) ? Math.round(n) : 0);
}

/** Percentual inteiro ("85%"). */
export function csvPct(n: number): string {
    return `${Number.isFinite(n) ? Math.round(n) : 0}%`;
}

/** `AAAA-MM-DD` (ou ISO) → `dd/mm/aaaa`, sem passar por fuso. Inválida → ''. */
export function csvDate(iso: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Instante → `dd/mm/aaaa hh:mm` no horário de Brasília (independente do fuso do aparelho). */
export function csvDateTime(d: Date): string {
    const parts = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

const pctOf = (count: number, total: number) => (total > 0 ? Math.round((count / total) * 100) : 0);
const sum = <T>(list: T[], pick: (item: T) => number) => list.reduce((acc, item) => acc + (pick(item) || 0), 0);

/** Nome do arquivo com o período real: `relatorio-estudio_2026-09-01_a_2026-09-30.csv`. */
export function reportCsvFileName(from: string, to: string): string {
    const clean = (s: string) => (/^\d{4}-\d{2}-\d{2}/.exec(s ?? '')?.[0] ?? 'data');
    return `relatorio-estudio_${clean(from)}_a_${clean(to)}.csv`;
}

/**
 * Monta o CSV da página Relatórios COMPLETA: cabeçalho + Resumo + Ocupação por horário + Ocupação
 * por dia da semana + Distribuição por faixa + Métricas de audiência + Ranking de clientes (inteiro).
 * Devolve o texto pronto para o Blob (BOM incluído).
 */
export function buildReportCsv(input: ReportCsvInput): string {
    const {
        from, to, periodLabel, generatedAt, summary, slotOccupancy, dayOccupancy, tierBreakdown, audience, ranking,
    } = input;
    const studio = input.studioName?.trim() || REPORT_CSV_STUDIO;
    const tierLabel = (tier: string) =>
        input.tierLabels?.[tier] ?? DEFAULT_TIER_LABELS[tier] ?? tier.replace(/_/g, ' ');

    const lines: string[] = [];
    const row = (...cells: Cell[]) => { lines.push(csvRow(cells)); };
    const blank = () => { lines.push(''); };
    /** Bloco de seção: linha em branco, título em linha própria e cabeçalho de colunas. */
    const section = (title: string, columns: string[]) => { blank(); row(title); row(...columns); };

    // ── Cabeçalho informativo (uma informação por linha) ──
    row(studio);
    row(REPORT_CSV_TITLE);
    row('Período', `${csvDate(from)} a ${csvDate(to)}`, periodLabel ?? '');
    row('Gerado em', `${csvDateTime(generatedAt)} (horário de Brasília)`);

    // ── Resumo (os cartões do topo da página) ──
    const faltaPct = summary.faltaBookings > 0 ? 100 - summary.attendanceRate : 0;
    section('RESUMO DO PERÍODO', ['Indicador', 'Valor', 'Detalhe']);
    row('Sessões', csvInt(summary.totalBookings), 'agendadas no período');
    row('Concluídas', csvInt(summary.completedBookings), `${csvPct(summary.attendanceRate)} de presença`);
    row('Faltas', csvInt(summary.faltaBookings), `${csvPct(faltaPct)} (faltas e gravações não realizadas)`);
    row('Cancelamentos', csvInt(summary.cancelledBookings), `${csvPct(summary.cancellationRate)} das sessões`);
    row('Receita', csvMoney(summary.totalRevenue), 'valor das sessões não canceladas');

    // ── Ocupação por horário ──
    section('OCUPAÇÃO POR HORÁRIO', ['Horário', 'Sessões', 'Dias úteis no período', 'Ocupação']);
    for (const s of slotOccupancy) row(s.label || s.slot, csvInt(s.count), csvInt(s.total), csvPct(s.pct));
    {
        const count = sum(slotOccupancy, s => s.count);
        const total = sum(slotOccupancy, s => s.total);
        row('TOTAL', csvInt(count), csvInt(total), csvPct(pctOf(count, total)));
    }

    // ── Ocupação por dia da semana ──
    section('OCUPAÇÃO POR DIA DA SEMANA', ['Dia', 'Sessões', 'Horários disponíveis', 'Ocupação']);
    for (const d of dayOccupancy) row(d.day, csvInt(d.count), csvInt(d.total), csvPct(d.pct));
    {
        const count = sum(dayOccupancy, d => d.count);
        const total = sum(dayOccupancy, d => d.total);
        row('TOTAL', csvInt(count), csvInt(total), csvPct(pctOf(count, total)));
    }

    // ── Distribuição por faixa ──
    section('DISTRIBUIÇÃO POR FAIXA', ['Faixa', 'Sessões', 'Participação', 'Receita']);
    for (const t of tierBreakdown) row(tierLabel(t.tier), csvInt(t.count), csvPct(t.pct), csvMoney(t.revenue));
    {
        const count = sum(tierBreakdown, t => t.count);
        row('TOTAL', csvInt(count), csvPct(count > 0 ? 100 : 0), csvMoney(sum(tierBreakdown, t => t.revenue)));
    }

    // ── Métricas de audiência ──
    section('MÉTRICAS DE AUDIÊNCIA', ['Indicador', 'Valor']);
    if (!audience || audience.totalCompleted === 0) {
        row('Sem dados de audiência', 'nenhuma sessão concluída neste período');
    } else {
        row('Sessões concluídas', csvInt(audience.totalCompleted));
        row('Média de viewers', csvInt(audience.avgViewers));
        row('Pico máximo de viewers', csvInt(audience.maxViewers));
        row('Média de mensagens no chat', csvInt(audience.avgChat));
        row('Duração média (min)', audience.avgDuration > 0 ? csvInt(audience.avgDuration) : '—');
    }

    // ── Ranking de clientes (completo) ──
    section('RANKING DE CLIENTES (COMPLETO, POR RECEITA)',
        ['Posição', 'Cliente', 'Sessões', 'Concluídas', 'Faltas', 'Receita', 'Média de viewers']);
    if (ranking.length === 0) {
        row('Nenhum dado de cliente neste período');
    } else {
        ranking.forEach((c, i) => row(
            i + 1, csvText(c.name), csvInt(c.sessions), csvInt(c.completed), csvInt(c.falta),
            csvMoney(c.revenue), c.avgViewers > 0 ? csvInt(c.avgViewers) : '—',
        ));
        row(
            'TOTAL', `${csvInt(ranking.length)} ${ranking.length === 1 ? 'cliente' : 'clientes'}`,
            csvInt(sum(ranking, c => c.sessions)), csvInt(sum(ranking, c => c.completed)),
            csvInt(sum(ranking, c => c.falta)), csvMoney(sum(ranking, c => c.revenue)), '',
        );
    }

    return REPORT_CSV_BOM + lines.join(REPORT_CSV_EOL) + REPORT_CSV_EOL;
}
