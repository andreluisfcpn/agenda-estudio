import React, { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/** Props que o Tooltip compõe no elemento filho (os handlers originais são preservados). */
type TriggerProps = Pick<
    React.HTMLAttributes<HTMLElement>,
    'onPointerEnter' | 'onPointerLeave' | 'onPointerDown' | 'onFocus' | 'onBlur' | 'aria-describedby'
>;

export interface TooltipProps {
    /** Texto (ou nó curto) da dica. Vazio/null/false = sem tooltip (o filho é devolvido intacto). */
    content: React.ReactNode;
    /**
     * UM elemento que recebe foco e repassa eventos de ponteiro/foco ao DOM
     * (<button>, <a> ou componente que espalhe essas props). Um componente que
     * não repassa as props falha em silêncio.
     */
    children: React.ReactElement<TriggerProps>;
    /** Lado preferido (padrão 'top'). Inverte sozinho se faltar espaço. */
    placement?: TooltipPlacement;
    /** Desliga sem desmontar o filho (ex.: sidebar expandida). */
    disabled?: boolean;
    /** Atraso de abertura no hover, em ms (padrão 250). Foco por teclado abre na hora. */
    delay?: number;
    /**
     * Liga `aria-describedby` do gatilho à bolha enquanto aberta (padrão true).
     * Use `false` quando o `aria-label` do gatilho já diz o mesmo (evita leitura dupla).
     */
    describe?: boolean;
    /** Classe extra na bolha. */
    className?: string;
}

const GAP = 8; // distância entre gatilho e bolha
const EDGE = 8; // margem mínima até a borda da janela
const ARROW_MIN = 10; // a seta nunca encosta na quina da bolha
const WARM_MS = 300; // janela de "aquecimento": passar de um gatilho a outro abre sem atraso

let lastClosedAt = 0;

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, Math.max(min, max)));

interface Position { top: number; left: number; placement: TooltipPlacement; arrow: number }

function computePosition(anchor: DOMRect, w: number, h: number, preferred: TooltipPlacement): Position {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const fits: Record<TooltipPlacement, boolean> = {
        top: anchor.top - GAP - h >= EDGE,
        bottom: anchor.bottom + GAP + h <= vh - EDGE,
        left: anchor.left - GAP - w >= EDGE,
        right: anchor.right + GAP + w <= vw - EDGE,
    };
    const placement = !fits[preferred] && fits[OPPOSITE[preferred]] ? OPPOSITE[preferred] : preferred;

    let top: number;
    let left: number;
    if (placement === 'top' || placement === 'bottom') {
        left = anchor.left + anchor.width / 2 - w / 2;
        top = placement === 'top' ? anchor.top - GAP - h : anchor.bottom + GAP;
    } else {
        top = anchor.top + anchor.height / 2 - h / 2;
        left = placement === 'left' ? anchor.left - GAP - w : anchor.right + GAP;
    }
    left = clamp(left, EDGE, vw - w - EDGE);
    top = clamp(top, EDGE, vh - h - EDGE);

    const arrow = placement === 'top' || placement === 'bottom'
        ? clamp(anchor.left + anchor.width / 2 - left, ARROW_MIN, w - ARROW_MIN)
        : clamp(anchor.top + anchor.height / 2 - top, ARROW_MIN, h - ARROW_MIN);

    return { top, left, placement, arrow };
}

function matchesFocusVisible(el: Element): boolean {
    try {
        return el.matches(':focus-visible');
    } catch {
        return false; // navegador sem :focus-visible → não abre por foco (evita abrir no toque)
    }
}

/**
 * Dica acessível para controles (principalmente botões só com ícone).
 *
 * - Renderiza a bolha num portal em document.body com position:fixed — escapa
 *   de qualquer overflow:hidden/auto (tabelas, sidebar, sheets).
 * - Abre no hover de MOUSE/CANETA (com atraso) e no foco por teclado
 *   (:focus-visible). NUNCA abre no toque.
 * - Fecha em pointerleave, pointerdown, blur, Escape (sem fechar o modal por
 *   trás), scroll (qualquer contêiner) e resize.
 * - Inverte o lado se faltar espaço e limita às bordas da janela.
 * - Compõe (não sobrescreve) os handlers do filho via cloneElement.
 *
 * Regra: botão só com ícone = `aria-label` + `<Tooltip>`. Quando o aria-label já
 * descreve a ação, use `describe={false}`.
 *
 * @example
 * <Tooltip content="Editar contrato" describe={false}>
 *   <button type="button" className="admin-icon-btn" aria-label={`Editar contrato ${c.name}`} onClick={...}>
 *     <Pencil size={16} aria-hidden="true" />
 *   </button>
 * </Tooltip>
 */
export default function Tooltip({
    content,
    children,
    placement = 'top',
    disabled = false,
    delay = 250,
    describe = true,
    className,
}: TooltipProps) {
    const id = useId();
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const [pos, setPos] = useState<Position | null>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const openRef = useRef(false);

    const isEmpty = content == null || content === false || content === '';
    const inactive = disabled || isEmpty;

    const clearTimer = useCallback(() => {
        if (timerRef.current != null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const close = useCallback(() => {
        clearTimer();
        if (openRef.current) {
            openRef.current = false;
            lastClosedAt = Date.now();
        }
        setAnchor(null);
    }, [clearTimer]);

    const openAt = useCallback((el: HTMLElement) => {
        clearTimer();
        if (!el.isConnected) return;
        openRef.current = true;
        setAnchor(el.getBoundingClientRect());
    }, [clearTimer]);

    // Desligou (ou ficou sem conteúdo) enquanto aberto → fecha.
    useEffect(() => {
        if (inactive) close();
    }, [inactive, close]);

    // Desmontou com timer pendente.
    useEffect(() => clearTimer, [clearTimer]);

    // Enquanto aberto: Escape, scroll (captura = qualquer contêiner) e resize fecham.
    useEffect(() => {
        if (!anchor) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // Só a dica fecha; o Escape seguinte chega ao modal/sheet normalmente (WCAG 1.4.13).
            e.stopPropagation();
            close();
        };
        const onScrollOrResize = () => close();
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
        window.addEventListener('resize', onScrollOrResize);
        return () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onScrollOrResize, { capture: true });
            window.removeEventListener('resize', onScrollOrResize);
        };
    }, [anchor, close]);

    // Mede a bolha (1º render invisível) e posiciona antes do paint.
    useLayoutEffect(() => {
        const bubble = bubbleRef.current;
        if (!anchor || !bubble) {
            setPos(null);
            return;
        }
        setPos(computePosition(anchor, bubble.offsetWidth, bubble.offsetHeight, placement));
    }, [anchor, content, placement]);

    const handlePointerEnter = (e: React.PointerEvent<HTMLElement>) => {
        if (inactive || e.pointerType === 'touch') return;
        const el = e.currentTarget;
        clearTimer();
        if (delay <= 0 || Date.now() - lastClosedAt < WARM_MS) {
            openAt(el);
        } else {
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                openAt(el);
            }, delay);
        }
    };

    const handleFocus = (e: React.FocusEvent<HTMLElement>) => {
        if (inactive) return;
        // e.target: o elemento que de fato recebeu foco (o evento borbulha de filhos).
        if (matchesFocusVisible(e.target)) openAt(e.currentTarget);
    };

    const child = !isValidElement<TriggerProps>(children) || inactive
        ? children
        : (() => {
            const p = children.props;
            const describedBy = [p['aria-describedby'], anchor && describe ? id : null]
                .filter(Boolean).join(' ') || undefined;
            return cloneElement(children, {
                onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
                    p.onPointerEnter?.(e);
                    if (!e.defaultPrevented) handlePointerEnter(e);
                },
                onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
                    p.onPointerLeave?.(e);
                    close();
                },
                onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
                    p.onPointerDown?.(e);
                    close();
                },
                onFocus: (e: React.FocusEvent<HTMLElement>) => {
                    p.onFocus?.(e);
                    if (!e.defaultPrevented) handleFocus(e);
                },
                onBlur: (e: React.FocusEvent<HTMLElement>) => {
                    p.onBlur?.(e);
                    close();
                },
                'aria-describedby': describedBy,
            });
        })();

    const bubble = anchor && !inactive && typeof document !== 'undefined'
        ? createPortal(
            <div
                ref={bubbleRef}
                id={id}
                role="tooltip"
                className={`ui-tooltip${className ? ` ${className}` : ''}`}
                data-placement={pos?.placement ?? placement}
                style={{
                    top: pos?.top ?? 0,
                    left: pos?.left ?? 0,
                    visibility: pos ? 'visible' : 'hidden',
                    ['--ui-tooltip-arrow' as string]: pos ? `${pos.arrow}px` : undefined,
                }}
            >
                {content}
            </div>,
            document.body,
        )
        : null;

    // Forma de retorno SEMPRE igual (filho + portal): alternar `disabled` não remonta o filho.
    return (
        <>
            {child}
            {bubble}
        </>
    );
}
