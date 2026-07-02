import React, { useEffect, useState, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import { X } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';

/** Desktop max-width preset: sm=480px (default, original behavior), md=640px,
 *  lg=820px, xl=1000px. On mobile (<640px) the sheet is always full-width and
 *  `size` has no effect. */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

interface BottomSheetModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
    /** Prevent closing (drag, backdrop, ESC) while an async action is in progress */
    preventClose?: boolean;
    /** Desktop max-width preset. Prefer this over `maxWidth`. */
    size?: ModalSize;
    /** @deprecated Use `size` instead. If present, wins over `size` (inline style). */
    maxWidth?: string;
    /** Hide the built-in header (drag handle + title + X). Useful when the child manages its own header. */
    hideHeader?: boolean;
    /** Extra CSS class on the card container */
    className?: string;
    /** Override z-index for stacking (default: 1000 from CSS) */
    zIndex?: number;
}

export default function BottomSheetModal({
    isOpen,
    onClose,
    title,
    children,
    preventClose = false,
    size = 'sm',
    maxWidth,
    hideHeader = false,
    className,
    zIndex,
}: BottomSheetModalProps) {
    const [isDesktop, setIsDesktop] = useState(false);
    // Height of the mobile bottom-tab bar when it is on screen — the sheet rises from
    // ABOVE it (menu stays visible/usable below) rather than covering it. 0 when absent.
    const [bottomNavInset, setBottomNavInset] = useState(0);
    const trapRef = useFocusTrap<HTMLDivElement>(isOpen);
    const titleId = useId();

    const safeClose = useCallback(() => {
        if (!preventClose) onClose();
    }, [preventClose, onClose]);

    // Check matchMedia for desktop
    useEffect(() => {
        const mq = window.matchMedia('(min-width: 640px)');
        setIsDesktop(mq.matches);
        const listener = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
        mq.addEventListener('change', listener);
        return () => mq.removeEventListener('change', listener);
    }, []);

    // Measure the bottom-tab bar (only present + visible on authenticated mobile pages) so
    // the sheet can sit on top of it instead of over it.
    useEffect(() => {
        if (!isOpen) return;
        const measure = () => {
            const nav = document.querySelector('.bottom-tab-bar-wrap');
            const rect = nav?.getBoundingClientRect();
            const visible = !!nav && getComputedStyle(nav).display !== 'none' && (rect?.height ?? 0) > 0;
            setBottomNavInset(visible ? Math.round(rect!.height) : 0);
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [isOpen]);

    // Lock body scroll
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = '';
            };
        }
    }, [isOpen]);

    // Handle escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                safeClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, safeClose]);

    const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
        const velocity = info.velocity.y;
        const offset = info.offset.y;

        if ((velocity > 300 || offset > 100) && !preventClose) {
            onClose();
        }
    };

    const overlayStyle: React.CSSProperties = {
        ...(zIndex ? { zIndex } : {}),
        // Shorten the overlay so it ends at the top of the bottom-tab bar (mobile only).
        ...(bottomNavInset > 0 ? { height: `calc(100svh - ${bottomNavInset}px)` } : {}),
    };
    const cardStyle: React.CSSProperties = {
        ...(maxWidth ? { maxWidth } : {}),
        ...(bottomNavInset > 0 ? { maxHeight: `calc(100svh - ${bottomNavInset}px - 16px)` } : {}),
    };
    // The <h2 id={titleId}> only renders when the header is shown AND a title is set.
    const hasRenderedTitle = !hideHeader && !!title;

    const content = (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    className="bottom-sheet-overlay"
                    style={overlayStyle}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    onMouseDown={(e: React.MouseEvent<HTMLDivElement>) => {
                        if (e.target === e.currentTarget) {
                            safeClose();
                        }
                    }}
                >
                    <motion.div
                        ref={trapRef}
                        className={`bottom-sheet-card bottom-sheet-card--${size} ${className || ''}`}
                        style={cardStyle}
                        initial={{ y: "100%" }}
                        animate={{ y: 0 }}
                        exit={{ y: "100%" }}
                        transition={{ type: "spring", stiffness: 350, damping: 30 }}
                        drag={isDesktop || preventClose ? false : "y"}
                        dragConstraints={{ top: 0, bottom: 0 }}
                        dragElastic={{ top: 0.05, bottom: 0.5 }}
                        onDragEnd={handleDragEnd}
                        onMouseDown={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label={hasRenderedTitle ? undefined : (title || 'Janela')}
                        aria-labelledby={hasRenderedTitle ? titleId : undefined}
                        tabIndex={-1}
                    >
                        {/* Grab handle (mobile) — sits outside the scroll body, so dragging it
                            triggers the sheet's drag-to-dismiss while the body keeps scrolling. */}
                        {!isDesktop && (
                            <div className="bottom-sheet-grabber">
                                <div className="bottom-sheet-handle" />
                            </div>
                        )}

                        {!hideHeader && (
                            <div className="bottom-sheet-header">
                                {(title || !isDesktop) && (
                                    <div className="bottom-sheet-title-row">
                                        <h2 className="bottom-sheet-title" id={titleId}>{title}</h2>
                                        <button
                                            onClick={safeClose}
                                            aria-label="Fechar"
                                            className="bottom-sheet-close-btn"
                                        >
                                            <X size={20} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        <div
                            className="bottom-sheet-body"
                            onPointerDown={isDesktop ? undefined : (e) => e.stopPropagation()}
                        >
                            {children}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );

    // Portal to <body> so the fixed overlay escapes any ancestor stacking context /
    // containing block (e.g. the topbar's backdrop-filter), keeping it above the
    // bottom-tab bar and everything else.
    return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}
