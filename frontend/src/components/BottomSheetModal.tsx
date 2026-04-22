import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import { X } from 'lucide-react';

interface BottomSheetModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: React.ReactNode;
    /** Prevent closing (drag, backdrop, ESC) while an async action is in progress */
    preventClose?: boolean;
    /** Override the default max-width (480px). Pass any CSS value. */
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
    maxWidth,
    hideHeader = false,
    className,
    zIndex,
}: BottomSheetModalProps) {
    const [isDesktop, setIsDesktop] = useState(false);

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

    const overlayStyle: React.CSSProperties = zIndex ? { zIndex } : {};
    const cardStyle: React.CSSProperties = maxWidth ? { maxWidth } : {};

    return (
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
                        className={`bottom-sheet-card ${className || ''}`}
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
                    >
                        {!hideHeader && (
                            <div className="bottom-sheet-header">
                                {/* Drag Handle & Area for mobile */}
                                <div className="bottom-sheet-drag-area">
                                    <div className="bottom-sheet-handle" />
                                </div>

                                {(title || !isDesktop) && (
                                    <div className="bottom-sheet-title-row">
                                        <h2 className="bottom-sheet-title">{title}</h2>
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
}
