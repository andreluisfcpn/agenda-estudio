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
        <section aria-label="Carrossel de serviços" style={{ padding: '120px 8%', background: 'var(--bg-card)', position: 'relative', overflow: 'hidden' }}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div style={{ maxWidth: '1200px', margin: '0 auto', textAlign: 'center' }}>
                <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: '8px',
                    color: 'var(--accent-primary)', fontWeight: 700, fontSize: '0.875rem', marginBottom: '16px',
                    padding: '6px 16px', background: 'rgba(139, 92, 246, 0.1)', borderRadius: '100px'
                }}>
                    <Sparkles size={16} /> PRODUÇÃO COMPLETA
                </div>
                
                <h2 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', fontWeight: 800, marginBottom: '60px', lineHeight: 1.1, letterSpacing: '-1px' }}>
                    Grave seu podcast no melhor estúdio e<br />deixe o <span style={{ color: 'var(--accent-primary)' }}>trabalho pesado com a gente.</span>
                </h2>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '40px', alignItems: 'center' }}>
                    
                    {/* Active Slide Display */}
                    <div style={{ position: 'relative', height: '340px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <AnimatePresence mode="wait">
                            <motion.div
                                key={activeIndex}
                                initial={{ opacity: 0, scale: 0.97, filter: 'blur(10px)' }}
                                animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                                exit={{ opacity: 0, scale: 0.97, filter: 'blur(10px)' }}
                                transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                                style={{
                                    background: 'rgba(255, 255, 255, 0.03)',
                                    border: '1px solid rgba(255, 255, 255, 0.08)',
                                    borderRadius: '24px',
                                    padding: '50px 40px',
                                    backdropFilter: 'blur(20px)',
                                    maxWidth: '800px',
                                    width: '100%',
                                    height: '100%',
                                    margin: '0 auto',
                                    boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'center'
                                }}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                    <div style={{ 
                                        width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(139, 92, 246, 0.15)', 
                                        color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        marginBottom: '24px', flexShrink: 0
                                    }}>
                                        {ICON_MAP[activeService.key]}
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
                        {addons.map((addon, index) => (
                            <button
                                key={addon.key}
                                onClick={() => handleThumbnailClick(index)}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: '8px',
                                    padding: '10px 20px', borderRadius: '100px', border: 'none',
                                    background: activeIndex === index ? 'var(--accent-primary)' : 'transparent',
                                    color: activeIndex === index ? '#fff' : 'var(--text-muted)',
                                    fontWeight: activeIndex === index ? 700 : 500,
                                    cursor: 'pointer', transition: 'all 0.3s ease',
                                    outline: 'none', boxShadow: activeIndex === index ? '0 8px 16px rgba(139, 92, 246, 0.3)' : 'none'
                                }}
                            >
                                <span style={{ transform: activeIndex === index ? 'scale(1.1)' : 'scale(1)' }}>
                                    {React.cloneElement(ICON_MAP[addon.key] as any, { size: 16 })}
                                </span>
                                {addon.name}
                            </button>
                        ))}
                    </div>

                </div>
            </div>
        </section>
    );
}
