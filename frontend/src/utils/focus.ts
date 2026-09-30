// ─── Focus helpers ──────────────────────────────────────────────────────────
// Opening a modal/sheet and immediately focusing an input pops the on-screen
// keyboard on mobile, covering the content and hurting UX. These helpers focus
// ONLY on devices with a fine pointer (mouse/trackpad), i.e. desktop.

// ─── Foco programático ──────────────────────────────────────────────────────
// O evento de foco dispara de forma SÍNCRONA dentro de `.focus()`. Marcar a chamada com um contador
// deixa quem escuta o foco (ex.: ui/Tooltip) saber, sem depender de tempo nem de ordem de tarefas,
// que aquele foco veio de script (foco inicial de um modal, foco devolvido ao fechar) e não de uma
// navegação do usuário por Tab/setas.
let programmaticDepth = 0;

/** Foca `el` marcando o foco como programático (ver `isProgrammaticFocus`). */
export function focusProgrammatically(el: HTMLElement): void {
    programmaticDepth++;
    try {
        el.focus();
    } finally {
        programmaticDepth--;
    }
}

/** True enquanto um `focusProgrammatically` está em andamento (só vale DENTRO do handler de foco). */
export const isProgrammaticFocus = (): boolean => programmaticDepth > 0;

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
        const t = setTimeout(() => focusProgrammatically(el), delay);
        return () => clearTimeout(t);
    }
    focusProgrammatically(el);
}
