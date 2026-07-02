import React, { useRef, useCallback, useEffect } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

/**
 * @deprecated Não usar em código novo — use BottomSheetModal (sheet no mobile,
 * dialog no desktop, prop `size`). Mantido apenas até a remoção após a Fase 1
 * da padronização do admin (ver docs/tecnico/design-system.md).
 *
 * ModalOverlay – wraps modal content and closes when:
 *  1. BOTH mousedown AND mouseup happen on the overlay (outside the modal)
 *  2. User presses Escape key
 *
 * This prevents the common UX issue where selecting text inside
 * a form field and accidentally releasing the mouse outside the
 * modal causes it to close.
 *
 * Accessibility: announces itself as a dialog, traps focus while open,
 * and restores focus to the trigger on close.
 */
interface ModalOverlayProps {
    onClose: () => void;
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    /** Set to true to prevent closing (e.g. while a request is in progress) */
    preventClose?: boolean;
    /** Accessible name for the dialog (use when there's no visible title to reference). */
    'aria-label'?: string;
    /** id of the element labelling the dialog (e.g. the title). */
    'aria-labelledby'?: string;
}

export default function ModalOverlay({
    onClose,
    children,
    className = 'modal-overlay',
    style,
    preventClose,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
}: ModalOverlayProps) {
    const mouseDownOnOverlay = useRef(false);
    const trapRef = useFocusTrap<HTMLDivElement>(true);

    // Escape key handler
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !preventClose) {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose, preventClose]);

    const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        // Record that the press started on the overlay itself (not a child)
        mouseDownOnOverlay.current = e.target === e.currentTarget;
    }, []);

    const handleMouseUp = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        // Close only if both mousedown and mouseup happened on the overlay
        if (mouseDownOnOverlay.current && e.target === e.currentTarget && !preventClose) {
            onClose();
        }
        mouseDownOnOverlay.current = false;
    }, [onClose, preventClose]);

    return (
        <div
            ref={trapRef}
            className={className}
            style={style}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            role="dialog"
            aria-modal="true"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledby}
        >
            {children}
        </div>
    );
}

