// Constantes e helpers da agenda — compartilhados entre CalendarPage (orquestrador),
// CalendarMobileView e CalendarDesktopView. Movidos verbatim de CalendarPage.tsx (R4 L2).

export const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Paleta vívida da grade escura (compartilhada com o admin) — divergente DE PROPÓSITO
// dos tokens --tier-* de index.css; não unificar sem pedido (mudaria o admin junto).
export const TIER_COLORS: Record<string, { color: string; bg: string; label: string }> = {
    comercial: { color: '#10b981', bg: 'rgba(16,185,129,0.10)', label: 'Comercial' },
    audiencia: { color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)', label: 'Audiência' },
    sabado:    { color: '#fbbf24', bg: 'rgba(245,158,11,0.10)', label: 'Sábado' },
};

export const GRID_ROWS = [
    { id: 'S1', type: 'SLOT', time: '10:00', timeEnd: '12:00', label: '10:00 - 12:00', height: 80 },
    { id: 'T1', type: 'TRANSITION', time: '12:00', timeEnd: '13:00', label: 'Intervalo para Almoço', height: 40 },
    { id: 'S2', type: 'SLOT', time: '13:00', timeEnd: '15:00', label: '13:00 - 15:00', height: 80 },
    { id: 'T2', type: 'TRANSITION', time: '15:00', timeEnd: '15:30', label: 'Higienização e Acomodação do próximo cliente', height: 30 },
    { id: 'S3', type: 'SLOT', time: '15:30', timeEnd: '17:30', label: '15:30 - 17:30', height: 80 },
    { id: 'T3', type: 'TRANSITION', time: '17:30', timeEnd: '18:00', label: 'Higienização', height: 30 },
    { id: 'S4', type: 'SLOT', time: '18:00', timeEnd: '20:00', label: '18:00 - 20:00', height: 80 },
    { id: 'T4', type: 'TRANSITION', time: '20:00', timeEnd: '20:30', label: 'Higienização', height: 30 },
    { id: 'S5', type: 'SLOT', time: '20:30', timeEnd: '22:30', label: '20:30 - 22:30', height: 80 },
];

export function getWeekDates(baseDate: Date): Date[] {
    const dates: Date[] = [];
    const d = new Date(baseDate);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    for (let i = 0; i < 6; i++) {
        dates.push(new Date(d));
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

export function formatDate(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatDateShort(d: Date): string { return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`; }

/** Info de um horário ocupado (meu agendamento ou, para admin, de qualquer cliente). */
export type BookingLookupInfo = { label: string; tier: string; isMine: boolean; myBooking?: import('../../api/client').MyBookingSlot };
export type BookingLookup = Record<string, BookingLookupInfo>;
