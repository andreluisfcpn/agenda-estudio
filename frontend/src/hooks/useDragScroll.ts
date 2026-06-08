import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hook for horizontally-scrollable rows (BottomTabBar, settings rail).
 * Adds: mouse drag-to-scroll, visibility flags for left/right "more content"
 * indicators, and a smooth scrollByPage helper for the side arrows.
 *
 * Touch scrolling stays native (overflow-x:auto). The hook only adds mouse
 * support and dynamic arrow visibility based on scrollLeft/clientWidth.
 */
export function useDragScroll<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [showLeft, setShowLeft] = useState(false);
    const [showRight, setShowRight] = useState(false);
    const [dragging, setDragging] = useState(false);

    const updateArrows = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow <= 1) {
            setShowLeft(false);
            setShowRight(false);
            return;
        }
        setShowLeft(el.scrollLeft > 4);
        setShowRight(el.scrollLeft < overflow - 4);
    }, []);

    // Mouse drag-to-scroll. Touch is native; this is for desktops/tablets w/
    // a mouse. The "is-dragging" class disables scroll-snap during the drag.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        let isDown = false;
        let didDrag = false;
        let startX = 0;
        let startScrollLeft = 0;

        const onDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            // Don't intercept clicks on side arrows
            const target = e.target as HTMLElement;
            if (target.closest('.scrollrow-arrow')) return;
            isDown = true;
            didDrag = false;
            startX = e.pageX;
            startScrollLeft = el.scrollLeft;
            el.classList.add('is-dragging');
        };
        const onMove = (e: MouseEvent) => {
            if (!isDown) return;
            const dx = e.pageX - startX;
            if (!didDrag && Math.abs(dx) > 4) {
                didDrag = true;
                setDragging(true);
            }
            if (didDrag) {
                e.preventDefault();
                el.scrollLeft = startScrollLeft - dx;
            }
        };
        const onUp = () => {
            if (!isDown) return;
            isDown = false;
            el.classList.remove('is-dragging');
            // Cancel the click that would follow a drag.
            if (didDrag) {
                const cancel = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
                el.addEventListener('click', cancel, { capture: true, once: true });
                setTimeout(() => setDragging(false), 0);
            } else {
                setDragging(false);
            }
        };

        el.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            el.removeEventListener('mousedown', onDown);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, []);

    // Update arrow visibility on scroll, resize, content changes.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        updateArrows();
        const onScroll = () => updateArrows();
        el.addEventListener('scroll', onScroll, { passive: true });
        let ro: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(updateArrows);
            ro.observe(el);
        }
        window.addEventListener('resize', updateArrows);
        // Re-check shortly after mount in case font/asset loading shifts widths.
        const t = setTimeout(updateArrows, 100);
        return () => {
            el.removeEventListener('scroll', onScroll);
            ro?.disconnect();
            window.removeEventListener('resize', updateArrows);
            clearTimeout(t);
        };
    }, [updateArrows]);

    const scrollByPage = useCallback((dir: 1 | -1) => {
        const el = ref.current;
        if (!el) return;
        el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.7), behavior: 'smooth' });
    }, []);

    return { ref, showLeft, showRight, dragging, scrollByPage, updateArrows };
}
