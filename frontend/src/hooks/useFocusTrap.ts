import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Accessibility helper for modal/dialog containers. When `active`:
 *  - traps Tab / Shift+Tab focus inside the returned container ref,
 *  - moves initial focus to the first focusable element (or the container),
 *  - restores focus to the element that was focused before opening, on cleanup.
 *
 * Returns a ref to attach to the dialog container element.
 * Purely additive — it never closes the modal (Escape stays in the caller).
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(active: boolean) {
    const containerRef = useRef<T | null>(null);

    useEffect(() => {
        if (!active) return;

        const container = containerRef.current;
        if (!container) return;

        // Remember what was focused so we can restore it on close.
        const previouslyFocused = document.activeElement as HTMLElement | null;

        // Move focus into the dialog after it mounts/animates in.
        const focusInitial = () => {
            const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
            const first = focusables[0];
            if (first) {
                first.focus();
            } else {
                // No focusable child — focus the container itself (needs tabIndex={-1}).
                container.focus();
            }
        };
        // rAF so framer-motion has mounted the content before we query/focus.
        const raf = requestAnimationFrame(focusInitial);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;
            const focusables = Array.from(
                container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
            ).filter((el) => el.offsetParent !== null || el === document.activeElement);
            if (focusables.length === 0) {
                e.preventDefault();
                container.focus();
                return;
            }
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const activeEl = document.activeElement as HTMLElement | null;

            if (e.shiftKey) {
                if (activeEl === first || !container.contains(activeEl)) {
                    e.preventDefault();
                    last.focus();
                }
            } else {
                if (activeEl === last || !container.contains(activeEl)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);

        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('keydown', handleKeyDown, true);
            // Restore focus to the trigger if it's still in the document.
            if (previouslyFocused && document.contains(previouslyFocused)) {
                previouslyFocused.focus();
            }
        };
    }, [active]);

    return containerRef;
}
