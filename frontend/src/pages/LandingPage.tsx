import React, { useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { motion, AnimatePresence } from 'framer-motion';
import PublicCalendarGrid from '../components/PublicCalendarGrid';
import ServicesCarousel from '../components/ServicesCarousel';

import LoginModal from '../components/LoginModal';
import VideoModal from '../components/VideoModal';
import { useAuth } from '../context/AuthContext';
import { PublicSlot } from '../api/client';

import {
    Calendar,
    BarChart3,
    ShieldCheck,
    ArrowRight,
    Mic2,
    Headphones,
    PlayCircle,
    LucideProps,
    CheckCircle2,
    Zap,
    Cpu,

    Sparkles,
    Wifi,
    Wind,
    Shield
} from 'lucide-react';

gsap.registerPlugin(ScrollTrigger);

// Búzios Digital Branding Colors
const COLORS = {
    primary: '#006C89',
    secondary: '#00485C',
    accent: '#E0F2F1',
    bgDark: '#001a1f',
    white: '#FFFFFF'
};

const ASSETS = {
    logo: 'https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg',
    heroImage: 'https://buzios.digital/wp-content/uploads/elementor/thumbs/bd-estudio-enhanced-sr-r9lm9twze86yo0wxu68fp1e0yf8baho28zrniyf1o0.jpg'
};

export default function LandingPage() {
    const navigate = useNavigate();
    const { fetchUser, user } = useAuth();

    const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
    const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
    const heroRef = useRef<HTMLDivElement>(null);
    const agendaRef = useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState(0);

    const scrollToCalendar = () => {
        agendaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    useEffect(() => {
        document.title = "Estúdio Búzios Digital — O Melhor Estúdio de Podcast e Vídeo em Búzios, RJ";
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            metaDesc.setAttribute("content", "Produza seu podcast ou vídeo no Estúdio Búzios Digital. Tecnologia 4K, automação com IA e ambiente climatizado no coração de Búzios. Reserve agora.");
        }

        const ctx = gsap.context(() => {
            // Hero Entrance
            gsap.from('.hero-text > *', {
                x: -40,
                opacity: 0,
                duration: 1,
                stagger: 0.1,
                ease: 'power3.out'
            });

            gsap.from('.hero-image-container', {
                opacity: 0,
                scale: 0.95,
                duration: 1.5,
                ease: 'power2.out',
                delay: 0.2
            });

            // Subtle breath for photo
            gsap.to('.hero-photo', {
                scale: 1.03,
                duration: 12,
                repeat: -1,
                yoyo: true,
                ease: 'sine.inOut'
            });


            // Pricing Card Entry
            gsap.from('.pricing-card', {
                scrollTrigger: {
                    trigger: '.pricing-card',
                    start: 'top 85%',
                },
                y: 60,
                opacity: 0,
                duration: 1.2,
                ease: 'power4.out'
            });

            gsap.from('.pricing-feature', {
                scrollTrigger: {
                    trigger: '.pricing-card',
                    start: 'top 80%',
                },
                x: -20,
                opacity: 0,
                duration: 0.6,
                stagger: 0.1,
                delay: 0.4,
                ease: 'power2.out'
            });
        }, heroRef);

        return () => ctx.revert();
    }, []);

    return (
        <div className="landing-root" style={{
            background: `linear-gradient(135deg, ${COLORS.secondary} 0%, ${COLORS.bgDark} 100%)`,
            minHeight: '100vh',
            color: COLORS.white,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            overflowX: 'hidden',
            position: 'relative'
        }}>
            {/* SEO Metadata & Grain Texture Container */}
            <svg style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 9999, opacity: 0.03 }}>
                <filter id="grain">
                    <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
                    <feColorMatrix type="saturate" values="0" />
                </filter>
                <rect width="100%" height="100%" filter="url(#grain)" />
            </svg>
            {/* Header / Navbar */}
            <header style={{
                position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
                padding: '20px 8%',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: 'rgba(0, 26, 31, 0.7)',
                backdropFilter: 'blur(20px)',
                borderBottom: '1px solid rgba(255,255,255,0.05)'
            }}>
                <nav style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <img
                            src={ASSETS.logo}
                            alt="Búzios Digital"
                            style={{ height: '32px', cursor: 'pointer' }}
                            onClick={() => window.open('https://buzios.digital', '_blank')}
                        />
                    </div>
                    {/* Desktop Menu */}
                    <div className="nav-desktop" style={{ display: 'flex', gap: '32px', alignItems: 'center' }}>
                        <button className="btn btn-ghost" onClick={() => setIsLoginModalOpen(true)} style={{ fontSize: '0.95rem', fontWeight: 600, color: COLORS.white }}>Área do Cliente</button>
                        <button className="btn" onClick={scrollToCalendar} style={{
                            background: COLORS.primary,
                            color: COLORS.white,
                            borderRadius: '10px',
                            padding: '10px 24px',
                            fontWeight: 700,
                            border: 'none',
                            fontSize: '0.9rem',
                            boxShadow: '0 8px 30px rgba(0, 108, 137, 0.3)'
                        }}>
                            RESERVAR AGORA
                        </button>
                    </div>

                    <style>{`
                        @media (max-width: 768px) {
                            .nav-desktop { display: none !important; }
                            .hero-text h1 { font-size: clamp(2.5rem, 10vw, 3.5rem) !important; letter-spacing: -1.5px !important; }
                        }
                    `}</style>
                </nav>
            </header>

            <main>
                {/* Hero Section */}
                <section ref={heroRef} style={{
                    padding: '180px 8% 100px',
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)',
                    alignItems: 'center',
                    gap: '80px',
                    minHeight: '95vh',
                    maxWidth: '1600px',
                    margin: '0 auto'
                }}>
                    <div className="hero-text">
                        <div style={{
                            display: 'inline-flex', alignItems: 'center', gap: '8px',
                            padding: '6px 14px', background: 'rgba(255,255,255,0.06)',
                            borderRadius: '100px', marginBottom: '24px',
                            fontSize: '0.8rem', fontWeight: 700, color: COLORS.accent,
                            letterSpacing: '1px'
                        }}>
                            <Sparkles size={14} /> ESTÚDIO DE PODCAST & VÍDEO
                        </div>
                        <h1 style={{ fontSize: 'clamp(3rem, 7vw, 5.2rem)', fontWeight: 800, lineHeight: 0.95, marginBottom: '24px', letterSpacing: '-3px' }}>
                            Transforme sua visão em <span style={{ color: COLORS.accent }}>excelência digital.</span>
                        </h1>
                        <p style={{ fontSize: '1.25rem', color: 'rgba(255,255,255,0.6)', lineHeight: 1.7, marginBottom: '48px', maxWidth: '540px' }}>
                            Produção profissional com tecnologia 4K, automação com IA e o suporte da maior agência de estratégia da região.
                        </p>
                        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                            <button className="btn" style={{
                                background: COLORS.white, color: COLORS.secondary, borderRadius: '12px',
                                padding: '20px 44px', fontSize: '1.1rem', fontWeight: 800, border: 'none',
                                boxShadow: '0 20px 40px rgba(0,0,0,0.3)', cursor: 'pointer'
                            }} onClick={scrollToCalendar}>
                                INICIAR PROJETO
                            </button>
                            <div onClick={() => setIsVideoModalOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', fontWeight: 700 }}>
                                <div style={{ width: '50px', height: '50px', borderRadius: '50%', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.1)' }}>
                                    <PlayCircle size={28} style={{ color: COLORS.white }} />
                                </div>
                                CONHECER ESPAÇO
                            </div>
                        </div>
                    </div>

                    <div className="hero-image-container" style={{
                        position: 'relative',
                        width: '100%',
                        aspectRatio: '16 / 11',
                        borderRadius: '40px',
                        overflow: 'hidden',
                        boxShadow: '0 50px 120px -30px rgba(0,0,0,0.9)',
                        border: '1px solid rgba(255,255,255,0.08)'
                    }}>
                        <img
                            src={ASSETS.heroImage}
                            className="hero-photo"
                            alt="Real Estúdio Búzios Digital"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,26,31,0.5), transparent)' }} />
                        <div style={{ position: 'absolute', bottom: '30px', left: '30px', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(10px)', padding: '12px 20px', borderRadius: '15px', border: '1px solid rgba(255,255,255,0.1)' }}>
                            <div style={{ fontSize: '0.8rem', opacity: 0.6 }}>LOCALIZAÇÃO</div>
                            <div style={{ fontWeight: 700 }}>Búzios, RJ</div>
                        </div>
                    </div>
                </section>



                <LoginModal
                    isOpen={isLoginModalOpen}
                    onClose={() => setIsLoginModalOpen(false)}
                />

                <VideoModal
                    isOpen={isVideoModalOpen}
                    onClose={() => setIsVideoModalOpen(false)}
                    videoUrl="https://www.youtube.com/embed/B6xNKgR3fQU?start=95"
                />



                {/* Dynamic Agenda Demo Section */}
                <section ref={agendaRef} style={{ padding: '120px 8%', background: 'rgba(0,0,0,0.2)' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', gap: '100px', alignItems: 'center', maxWidth: '1400px', margin: '0 auto' }}>
                        <div>
                            <div style={{ color: COLORS.primary, fontWeight: 700, marginBottom: '16px', letterSpacing: '2px' }}>FLUXO INTELIGENTE</div>
                            <h2 style={{ fontSize: '3rem', fontWeight: 800, marginBottom: '32px', lineHeight: 1.1 }}>Agenda fácil.<br />Foco no conteúdo.</h2>
                            <p style={{ color: 'rgba(255,255,255,0.5)', lineHeight: 1.8, marginBottom: '40px' }}>
                                Nosso sistema exclusivo permite que você reserve seu horário em segundos. Sem burocracia, sem espera. A agilidade que seu projeto exige.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                                {[
                                    { t: 'Escolha seu Slot', d: 'Bloqueios fixos de 2h para máxima qualidade.' },
                                    { t: 'Confirmação Real-Time', d: 'Seu estúdio garantido instantaneamente.' },
                                    { t: 'Gerenciamento Total', d: 'Acompanhe métricas e gravações em um só lugar.' }
                                ].map((item, i) => (
                                    <div key={i} style={{ display: 'flex', gap: '16px' }}>
                                        <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: COLORS.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                            <CheckCircle2 size={14} color="#fff" />
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700 }}>{item.t}</div>
                                            <div style={{ fontSize: '0.9rem', opacity: 0.5 }}>{item.d}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Live Calendar Grid */}
                        <div style={{ flex: 1, minWidth: '320px' }}>
                            <PublicCalendarGrid onSlotSelect={(date, slot) => {
                                if (user) {
                                    navigate('/calendar', {
                                        state: {
                                            preSelectedDate: date,
                                            preSelectedTime: slot.time
                                        }
                                    });
                                } else {
                                    sessionStorage.setItem('pendingBooking', JSON.stringify({ date, time: slot.time }));
                                    setIsLoginModalOpen(true);
                                }
                            }} />
                        </div>
                    </div>
                </section>

                {/* Services Carousel */}
                <ServicesCarousel />
            </main>

            {/* Footer */}
            <footer style={{ padding: '80px 8% 60px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '60px', position: 'relative', zIndex: 1 }}>
                <div>
                    <img src={ASSETS.logo} alt="Búzios Digital" style={{ height: '28px', marginBottom: '24px' }} />
                    <p style={{ maxWidth: '300px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>Excelência e inovação em produção audiovisual e estratégica digital da Búzios Digital.</p>
                </div>
                <div style={{ display: 'flex', gap: '80px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        <span style={{ fontWeight: 700 }}>CONTATO</span>
                        <span style={{ opacity: 0.5 }}>(22) 3301-5850</span>
                        <span style={{ opacity: 0.5 }}>contato@buzios.digital</span>
                    </div>
                </div>
            </footer>
        </div>
    );
}
