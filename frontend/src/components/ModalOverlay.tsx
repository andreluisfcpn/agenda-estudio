import React, { useRef, useCallback, useEffect } from 'react';

/**
 * ModalOverlay – wraps modal content and closes when:
 *  1. BOTH mousedown AND mouseup happen on the overlay (outside the modal)
 *  2. User presses Escape key
 *
 * This prevents the common UX issue where selecting text inside
 * a form field and accidentally releasing the mouse outside the
 * modal causes it to close.
 */
interface ModalOverlayProps {
    onClose: () => void;
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    /** Set to true to prevent closing (e.g. while a request is in progress) */
    preventClose?: boolean;
}

export default function ModalOverlay({ onClose, children, className = 'modal-overlay', style, preventClose }: ModalOverlayProps) {
    const mouseDownOnOverlay = useRef(false);

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
            className={className}
            style={style}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
        >
            {children}
        </div>
    );
}

