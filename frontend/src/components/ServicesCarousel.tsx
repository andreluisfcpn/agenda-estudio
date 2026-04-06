import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Scissors, User, Share2, Youtube, FileText, ChevronRight, ChevronLeft, Sparkles, Tag } from 'lucide-react';
import { pricingApi, AddOnConfig } from '../api/client';

const ICON_MAP: Record<string, React.ReactNode> = {
    'CORTES_IA': <Scissors size={24} />,
    'CORTES_HUMANO': <User size={24} />,
    'GESTAO_SOCIAL': <Share2 size={24} />,
    'YOUTUBE_SEO': <Youtube size={24} />,
    'PAUTAS': <FileText size={24} />
};

const DEFAULT_ORDER = ['CORTES_IA', 'CORTES_HUMANO', 'GESTAO_SOCIAL', 'YOUTUBE_SEO', 'PAUTAS'];

export default function ServicesCarousel() {
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [activeIndex, setActiveIndex] = useState(0);
    const [isHovered, setIsHovered] = useState(false);
    const timerRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        pricingApi.getAddons().then(res => {
            // Sort to match DEFAULT_ORDER
            const sorted = [...res.addons].sort((a, b) => {
                return DEFAULT_ORDER.indexOf(a.key) - DEFAULT_ORDER.indexOf(b.key);
            });
            setAddons(sorted);
        }).catch(err => console.error("Error fetching addons:", err));
    }, []);

    const resetTimer = () => {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
            if (!isHovered && addons.length > 0) {
                setActiveIndex((prev) => (prev + 1) % addons.length);
            }
        }, 5000);
    };

    useEffect(() => {
        resetTimer();
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [addons, isHovered]);

    const handleThumbnailClick = (index: number) => {
        setActiveIndex(index);
        resetTimer(); // Restart autoplay
    };

    if (addons.length === 0) return null;

    const activeService = addons[activeIndex];

    return (
        <section aria-label="Carrossel de serviços" style={{ padding: '120px 8%', background: 'transparent', position: 'relative', overflow: 'hidden' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div style={{ maxWidth: '1200px', margin: '0 auto', textAlign: 'center' }}>
                <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '8px',
                    color: '#11819B', fontWeight: 700, fontSize: '0.875rem', marginBottom: '16px',
                    padding: '6px 16px', background: 'rgba(17, 129, 155, 0.1)', borderRadius: '100px',
                    border: '1px solid rgba(17, 129, 155, 0.2)'
                }}>
                    <Sparkles size={16} /> PRODUÇÃO COMPLETA
                </div>

                <h2 style={{ fontSize: 'clamp(2.5rem, 5vw, 3.8rem)', fontWeight: 800, marginBottom: '60px', lineHeight: 1.15, letterSpacing: '-1px' }}>
                    Grave seu podcast no melhor estúdio e<br />deixe o <span style={{ color: '#11819B' }}>trabalho pesado com a gente.</span>
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '40px', alignItems: 'center' }}>

                    {/* Active Slide Display */}
                    <div style={{ position: 'relative', height: '340px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {/* Animated Ambient Glow */}
                        <motion.div
                            key={`glow-${activeIndex}`}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: [0, 0.3, 0.15], scale: [0.8, 1.1, 1], rotate: [0, 45, 0] }}
                            transition={{ duration: 3, ease: "easeOut" }}
                            style={{
                                position: 'absolute',
                                width: '50%',
                                height: '50%',
                                background: '#11819B',
                                borderRadius: '50%',
                                filter: 'blur(80px)',
                                zIndex: 0
                            }}
                        />
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={activeIndex}
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -20 }}
                                transition={{ duration: 0.4, ease: "easeOut" }}
                                style={{
                                    background: 'rgba(0, 46, 56, 0.6)',
                                    border: '1px solid rgba(255, 255, 255, 0.1)',
                                    borderRadius: '32px',
                                    padding: '50px 40px',
                                    backdropFilter: 'blur(24px)',
                                    WebkitBackdropFilter: 'blur(24px)',
                                    maxWidth: '800px',
                                    width: '100%',
                                    height: '100%',
                                    margin: '0 auto',
                                    boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.05)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center'
                                }}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                    <div style={{
                                        width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(17, 129, 155, 0.15)',
                                        color: '#11819B', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        marginBottom: '24px', flexShrink: 0, border: '1px solid rgba(17, 129, 155, 0.3)',
                                        boxShadow: '0 0 20px rgba(17, 129, 155, 0.2)'
                                    }}>
                                        {ICON_MAP[activeService.key] || <Sparkles size={24} />}
                                    </div>
                                    <h3 style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '16px' }}>{activeService.name}</h3>
                                    <p style={{ fontSize: '1.125rem', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '0', maxWidth: '600px', flexGrow: 1 }}>
                                        {activeService.description}
                                    </p>
                                </div>
                            </motion.div>
                        </AnimatePresence>
                    </div>

                    {/* Thumbnail Navigation */}
                    <div style={{
                        display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap',
                        padding: '20px', background: 'rgba(0,0,0,0.2)', borderRadius: '100px',
                        width: 'fit-content', margin: '0 auto'
                    }}>
                        {addons.map((addon, index) => {
                            const iconElement = ICON_MAP[addon.key] || <Sparkles size={24} />;
                            return (
                                <button
                                    key={addon.key}
                                    onClick={() => handleThumbnailClick(index)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '8px',
                                        padding: '10px 20px', borderRadius: '100px', border: 'none',
                                        background: activeIndex === index ? '#11819B' : 'transparent',
                                        color: activeIndex === index ? '#F4F9FA' : 'rgba(255,255,255,0.6)',
                                        fontWeight: activeIndex === index ? 800 : 500,
                                        cursor: 'pointer', transition: 'all 0.3s ease',
                                        outline: 'none', boxShadow: activeIndex === index ? '0 8px 16px rgba(17, 129, 155, 0.4)' : 'none'
                                    }}
                                >
                                    <span style={{ transform: activeIndex === index ? 'scale(1.1)' : 'scale(1)' }}>
                                        {React.cloneElement(iconElement as any, { size: 16 })}
                                    </span>
                                    {addon.name}
                                </button>
                            );
                        })}
                    </div>

                </div>
            </div>
        </section>
    );
}
