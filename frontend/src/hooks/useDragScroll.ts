import { useCallback, useEffect, useState } from 'react';

/**
 * Hook for horizontally-scrollable rows (BottomTabBar, settings rail, recordings
 * gallery). Adds: mouse drag-to-scroll, visibility flags for left/right "more
 * content" indicators, and a smooth scrollByPage helper for the side arrows.
 *
 * Touch scrolling stays native (overflow-x:auto). The hook only adds mouse
 * support and dynamic arrow visibility based on scrollLeft/clientWidth.
 *
 * The tracked node is held in STATE via a callback ref (not useRef) so the
 * effects (re)attach whenever the element mounts/unmounts. This is required for
 * elements rendered conditionally — e.g. a gallery that only appears AFTER a
 * loading state, where a plain useRef would be null at mount and the listeners
 * (with [] deps) would never attach.
 */
export function useDragScroll<T extends HTMLElement>() {
    const [el, setEl] = useState<T | null>(null);
    const ref = useCallback((node: T | null) => setEl(node), []);
    const [showLeft, setShowLeft] = useState(false);
    const [showRight, setShowRight] = useState(false);
    const [dragging, setDragging] = useState(false);

    const updateArrows = useCallback(() => {
        if (!el) return;
        const overflow = el.scrollWidth - el.clientWidth;
        if (overflow <= 1) {
            setShowLeft(false);
            setShowRight(false);
            return;
        }
        setShowLeft(el.scrollLeft > 4);
        setShowRight(el.scrollLeft < overflow - 4);
    }, [el]);

    // Mouse drag-to-scroll. Touch is native; this is for desktops/tablets w/
    // a mouse. The "is-dragging" class disables scroll-snap during the drag (and,
    // in the poster gallery, makes the cards inert via pointer-events:none).
    //
    // A classe só entra quando o arraste COMEÇA de fato (> 4px), nunca no
    // mousedown: aplicada no mousedown, o pointer-events:none fazia o mouseup cair
    // na trilha e o navegador disparava o click no ancestral comum (a trilha), não
    // no card — um clique simples do mouse não abria nada (E12).
    useEffect(() => {
        if (!el) return;
        let isDown = false;
        let didDrag = false;
        let startX = 0;
        let startScrollLeft = 0;
        // Verdadeiro só entre o mouseup de um arraste e o fim do MESMO ciclo de
        // eventos: engole o click que o navegador dispara logo após o mouseup.
        let suppressClick = false;
        let suppressTimer: ReturnType<typeof setTimeout> | null = null;
        let draggingTimer: ReturnType<typeof setTimeout> | null = null;

        const endDrag = () => {
            isDown = false;
            el.classList.remove('is-dragging');
            if (didDrag) {
                // O click pós-arraste (quando existe) é despachado em seguida ao
                // mouseup, antes de qualquer timer. Se o arraste terminou FORA da
                // trilha não há click nenhum: a flag cai no próximo tick e o clique
                // legítimo seguinte passa (antes um listener `once` ficava pendurado
                // e engolia esse clique).
                suppressClick = true;
                if (suppressTimer) clearTimeout(suppressTimer);
                suppressTimer = setTimeout(() => { suppressClick = false; suppressTimer = null; }, 0);
                if (draggingTimer) clearTimeout(draggingTimer);
                draggingTimer = setTimeout(() => { setDragging(false); draggingTimer = null; }, 0);
            } else {
                setDragging(false);
            }
            didDrag = false;
        };

        const onDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            // Don't intercept clicks on side arrows
            const target = e.target as HTMLElement;
            if (target.closest('.scrollrow-arrow')) return;
            isDown = true;
            didDrag = false;
            startX = e.pageX;
            startScrollLeft = el.scrollLeft;
        };
        const onMove = (e: MouseEvent) => {
            if (!isDown) return;
            // Botão solto fora da janela (o mouseup não chegou): encerra o arraste.
            if (e.buttons === 0) { endDrag(); return; }
            const dx = e.pageX - startX;
            if (!didDrag && Math.abs(dx) > 4) {
                didDrag = true;
                el.classList.add('is-dragging');
                setDragging(true);
            }
            if (didDrag) {
                e.preventDefault();
                el.scrollLeft = startScrollLeft - dx;
            }
        };
        const onUp = () => {
            if (!isDown) return;
            endDrag();
        };
        // Cancel the click that would follow a drag (capture: antes do onClick do item).
        const onClickCapture = (ev: MouseEvent) => {
            if (!suppressClick) return;
            suppressClick = false;
            ev.preventDefault();
            ev.stopPropagation();
        };

        el.addEventListener('mousedown', onDown);
        el.addEventListener('click', onClickCapture, true);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            el.removeEventListener('mousedown', onDown);
            el.removeEventListener('click', onClickCapture, true);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            el.classList.remove('is-dragging');
            if (suppressTimer) clearTimeout(suppressTimer);
            if (draggingTimer) clearTimeout(draggingTimer);
        };
    }, [el]);

    // Update arrow visibility on scroll, resize, content changes.
    useEffect(() => {
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
    }, [el, updateArrows]);

    const scrollByPage = useCallback((dir: 1 | -1) => {
        if (!el) return;
        el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.7), behavior: 'smooth' });
    }, [el]);

    return { ref, showLeft, showRight, dragging, scrollByPage, updateArrows };
}
