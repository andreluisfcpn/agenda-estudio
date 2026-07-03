// ─── Grade de horários do estúdio ────────────────────────
// Fonte única dos 5 slots diários — antes duplicada como SLOT_GRID
// (DashboardPage) e TIMELINE (AdminTodayPage). Horários em wall-clock
// de America/Sao_Paulo (ver utils/time.ts).
import { Utensils, Brush, type LucideIcon } from 'lucide-react';

export interface StudioSlot {
    time: string;
    end: string;
    label: string;
}

export const STUDIO_SLOTS: StudioSlot[] = [
    { time: '10:00', end: '12:00', label: '10h — 12h' },
    { time: '13:00', end: '15:00', label: '13h — 15h' },
    { time: '15:30', end: '17:30', label: '15h30 — 17h30' },
    { time: '18:00', end: '20:00', label: '18h — 20h' },
    { time: '20:30', end: '22:30', label: '20h30 — 22h30' },
];

export interface TimelineItem {
    id: string;
    type: 'SLOT' | 'BREAK';
    time: string;
    timeEnd: string;
    label: string;
    breakLabel?: string;
    breakIcon?: LucideIcon;
}

/** STUDIO_SLOTS intercalados com os 4 intervalos do dia (almoço + higienizações). */
export function buildDayTimeline(): TimelineItem[] {
    return [
        { id: 'S1', type: 'SLOT', time: '10:00', timeEnd: '12:00', label: '10h — 12h' },
        { id: 'T1', type: 'BREAK', time: '12:00', timeEnd: '13:00', label: '12:00 — 13:00', breakLabel: 'Intervalo para Almoço', breakIcon: Utensils },
        { id: 'S2', type: 'SLOT', time: '13:00', timeEnd: '15:00', label: '13h — 15h' },
        { id: 'T2', type: 'BREAK', time: '15:00', timeEnd: '15:30', label: '15:00 — 15:30', breakLabel: 'Higienização', breakIcon: Brush },
        { id: 'S3', type: 'SLOT', time: '15:30', timeEnd: '17:30', label: '15h30 — 17h30' },
        { id: 'T3', type: 'BREAK', time: '17:30', timeEnd: '18:00', label: '17:30 — 18:00', breakLabel: 'Higienização', breakIcon: Brush },
        { id: 'S4', type: 'SLOT', time: '18:00', timeEnd: '20:00', label: '18h — 20h' },
        { id: 'T4', type: 'BREAK', time: '20:00', timeEnd: '20:30', label: '20:00 — 20:30', breakLabel: 'Higienização', breakIcon: Brush },
        { id: 'S5', type: 'SLOT', time: '20:30', timeEnd: '22:30', label: '20h30 — 22h30' },
    ];
}
