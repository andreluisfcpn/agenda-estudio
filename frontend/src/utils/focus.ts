// ─── Focus helpers ──────────────────────────────────────────────────────────
// Opening a modal/sheet and immediately focusing an input pops the on-screen
// keyboard on mobile, covering the content and hurting UX. These helpers focus
// ONLY on devices with a fine pointer (mouse/trackpad), i.e. desktop.

/** True on touch / coarse-pointer devices (phones, tablets). */
export function isTouchDevice(): boolean {
    return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Focus an element, but skip on touch devices so the keyboard doesn't auto-open.
 * Optionally delay (e.g. to wait for an open animation).
 */
export function focusUnlessTouch(el: HTMLElement | null | undefined, delay = 0): (() => void) | void {
    if (!el || isTouchDevice()) return;
    if (delay > 0) {
        const t = setTimeout(() => el.focus(), delay);
        return () => clearTimeout(t);
    }
    el.focus();
}
