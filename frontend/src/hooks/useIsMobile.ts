import { useState, useEffect } from 'react';

/**
 * Viewport mobile? (largura <= breakpoint). Hook global — substitui as cópias
 * locais que existiam em CalendarPage e NotificationBell.
 * Obs.: o BottomSheetModal usa 640px de propósito (sheet vs dialog) — não migrar.
 */
export function useIsMobile(breakpoint = 768) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}
