// ─── Gravação na visão do cliente (E11/E12) ─────────────────────────────────
// Regras de exibição compartilhadas por "Minhas Gravações", Agenda → "Seus
// Agendamentos", Início e o modal de detalhe:
//   • "AO VIVO" = SÓ `isRecordingNow` (derivado pelo backend: CONFIRMED + "Iniciar
//     Gravação" e ainda não finalizada). Nunca `isLivestream`.
//   • `isLivestream` é um atributo permanente ("foi transmitida ao vivo") e vira
//     apenas o selo discreto "Transmitida ao vivo" em gravações CONCLUÍDAS.
//   • `isRecordingNow` é calculado na resposta do servidor — para o selo ligar e
//     desligar sozinho é preciso recarregar (useRecordingWatch).

import { useEffect, useRef } from 'react';
import { studioSlotDate, todayStrSaoPaulo } from './time';
import {
    PLATFORMS, PLATFORM_BY_KEY, parsePlatformLinks, parsePlatforms, parseStreamMetrics,
    type PlatformMetric,
} from '../constants/platforms';

/** Rótulos dos selos (um lugar só, para as telas e a11y dizerem a mesma coisa). */
export const LIVE_BADGE_LABEL = 'AO VIVO';
export const LIVE_STATUS_LABEL = 'Gravando agora';
export const LIVESTREAMED_LABEL = 'Transmitida ao vivo';

/** Intervalo do recarregamento enquanto há sessão de hoje em aberto. */
export const RECORDING_POLL_MS = 30_000;

interface LiveLike { status: string; isRecordingNow?: boolean | null }
interface SessionLike extends LiveLike { date: string; holdExpiresAt?: string | null }

/** A gravação está acontecendo AGORA — único critério do selo "AO VIVO". */
export function isRecordingLive(b: LiveLike | null | undefined): boolean {
    return !!b && b.isRecordingNow === true;
}

/** Gravação CONCLUÍDA que foi transmitida ao vivo — selo discreto, nunca "AO VIVO". */
export function wasLivestreamed(b: { status: string; isLivestream?: boolean | null } | null | undefined): boolean {
    return !!b && b.status === 'COMPLETED' && b.isLivestream === true;
}

/**
 * Sessão que pode ligar/desligar o "AO VIVO" a qualquer momento: a que já está em
 * gravação ou uma CONFIRMADA ou RESERVADA de hoje (fuso do estúdio). A reserva feita
 * pelo cliente nasce RESERVED e só vira CONFIRMED no check-in — é justamente ela que
 * passa por check-in + "Iniciar gravação" com a tela aberta. Reserva com o prazo de
 * pagamento (hold) já vencido não conta. Enquanto existir uma, a tela recarrega a
 * lista periodicamente.
 */
export function isOpenSessionToday(b: SessionLike, today: string = todayStrSaoPaulo()): boolean {
    if (isRecordingLive(b)) return true;
    if (b.date.split('T')[0] !== today) return false;
    if (b.status === 'CONFIRMED') return true;
    return b.status === 'RESERVED' && !(b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() <= Date.now());
}

/**
 * Instante (ms) em que a sessão termina no fuso do estúdio. Horário de fim ausente/ilegível ou que não
 * vem depois do início (dado legado) cai em início + 2h — a sessão nunca "termina antes de começar".
 */
export function sessionEndMs(dateStr: string, startTime: string, endTime?: string | null): number {
    const start = studioSlotDate(dateStr, startTime).getTime();
    const end = endTime ? studioSlotDate(dateStr, endTime).getTime() : NaN;
    return Number.isFinite(end) && end > start ? end : start + 2 * 3_600_000;
}

export function hasOpenSessionToday(list: readonly SessionLike[]): boolean {
    const today = todayStrSaoPaulo();
    return list.some(b => isOpenSessionToday(b, today));
}

/**
 * Recarrega os dados enquanto `active` (há sessão de hoje em aberto): a cada
 * RECORDING_POLL_MS com a aba visível e, por padrão, sempre que a aba volta a
 * ficar visível (mesmo sem sessão de hoje — refaz a leitura ao voltar ao app).
 * `reload` deve ser silencioso (sem esqueleto/piscar) e tolerar falha.
 */
export function useRecordingWatch(
    active: boolean,
    reload: () => void,
    opts: { intervalMs?: number; onVisible?: boolean } = {},
): void {
    const { intervalMs = RECORDING_POLL_MS, onVisible = true } = opts;
    const reloadRef = useRef(reload);
    reloadRef.current = reload;

    useEffect(() => {
        if (!active) return;
        const id = window.setInterval(() => {
            if (document.visibilityState === 'visible') reloadRef.current();
        }, intervalMs);
        return () => window.clearInterval(id);
    }, [active, intervalMs]);

    useEffect(() => {
        if (!onVisible) return;
        const handler = () => { if (document.visibilityState === 'visible') reloadRef.current(); };
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
    }, [onVisible]);
}

// ─── Formatação ─────────────────────────────────────────────────────────────

/** 'HH:MM' no fuso do estúdio (America/Sao_Paulo) de um instante ISO; '' se inválido. */
export function formatStudioClock(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** 95 → '1h 35min'; 45 → '45 min'; 120 → '2h'. null/0 → ''. */
export function formatDurationMinutes(min: number | null | undefined): string {
    if (!min || min <= 0) return '';
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h === 0) return `${m} min`;
    return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

// ─── Métricas da gravação ───────────────────────────────────────────────────

export interface RecordingMetricsSource {
    streamMetrics?: string | null;
    platformLinks?: string | null;
    platforms?: string | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
}

export interface RecordingNetworkRow {
    key: string;
    label: string;
    color?: string;
    metric: PlatformMetric;
    /** Tem ao menos um número registrado nesta rede. */
    hasMetrics: boolean;
    link: string;
}

export interface RecordingSummary {
    /** Soma das redes (o pico é o MAIOR entre as redes; sem dado por rede, cai no agregado legado `peakViewers`). */
    totals: { views: number; peak: number; subscribers: number; likes: number; comments: number };
    /** Mensagens no chat (agregado da sessão) — null quando não informado. */
    chatMessages: number | null;
    /** Redes com métrica, link ou planejadas — na ordem do catálogo. */
    networks: RecordingNetworkRow[];
    /** Link da gravação não transmitida (platformLinks.GRAVACAO). */
    recordingLink: string;
    /** Algum número de audiência foi registrado. */
    hasAudience: boolean;
}

const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Só http(s) vira link clicável (o valor é digitado pelo estúdio; nunca `javascript:`/`data:` etc.).
 * Endereço digitado SEM esquema que parece um domínio ("youtu.be/abc", "www.youtube.com/live/x") ganha
 * `https://` — rede de segurança para links já gravados sem o protocolo. Qualquer valor com outro esquema
 * (tem ":" antes do caminho: `javascript:…`, `data:…`, `localhost:3000`) continua descartado.
 */
export const safeUrl = (v: unknown): string => {
    if (typeof v !== 'string') return '';
    const s = v.trim();
    if (/^https?:\/\//i.test(s)) return s;
    return /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s) ? `https://${s}` : '';
};

/** Junta tudo o que o estúdio registrou no encerramento numa forma pronta para exibir. */
export function summarizeRecording(b: RecordingMetricsSource): RecordingSummary {
    const sm = parseStreamMetrics(b.streamMetrics);
    const links = parsePlatformLinks(b.platformLinks);
    const planned = parsePlatforms(b.platforms);

    const keys: string[] = [];
    const push = (k: string) => { if (k && k !== 'GRAVACAO' && !keys.includes(k)) keys.push(k); };
    // Ordem do catálogo primeiro; chaves desconhecidas (legado) depois.
    const known = new Set([...Object.keys(sm), ...Object.keys(links), ...planned]);
    PLATFORMS.forEach(p => { if (known.has(p.key)) push(p.key); });
    known.forEach(push);

    const totals = { views: 0, peak: 0, subscribers: 0, likes: 0, comments: 0 };
    const networks: RecordingNetworkRow[] = keys.map(key => {
        const metric = (sm[key] && typeof sm[key] === 'object' ? sm[key] : {}) as PlatformMetric;
        totals.views += num(metric.views);
        totals.peak = Math.max(totals.peak, num(metric.peak));
        totals.subscribers += num(metric.subscribers);
        totals.likes += num(metric.likes);
        totals.comments += num(metric.comments);
        const hasMetrics = num(metric.views) + num(metric.peak) + num(metric.subscribers) + num(metric.likes) + num(metric.comments) > 0;
        const link = safeUrl(links[key]);
        return { key, label: PLATFORM_BY_KEY[key]?.label || key, color: PLATFORM_BY_KEY[key]?.color, metric, hasMetrics, link };
    });
    if (totals.peak === 0) totals.peak = num(b.peakViewers);

    const chatMessages = b.chatMessages != null && num(b.chatMessages) > 0 ? num(b.chatMessages) : null;
    const hasAudience = totals.views + totals.peak + totals.subscribers + totals.likes + totals.comments > 0 || chatMessages != null;

    return {
        totals,
        chatMessages,
        networks,
        recordingLink: safeUrl(links.GRAVACAO),
        hasAudience,
    };
}
