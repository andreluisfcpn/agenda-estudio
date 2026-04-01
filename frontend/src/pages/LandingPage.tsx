import React, { useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { motion, AnimatePresence } from 'framer-motion';
import PublicCalendarGrid from '../components/PublicCalendarGrid';
import ServicesCarousel from '../components/ServicesCarousel';
import AmbientBackground from '../components/AmbientBackground';

import LoginModal from '../components/LoginModal';
import VideoModal from '../components/VideoModal';
import { useAuth } from '../context/AuthContext';
import { PublicSlot, pricingApi } from '../api/client';

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
    primary: '#11819B',
    secondary: '#096E85',
    accent: '#F4F9FA',
    bgDark: '#001e26',
    white: '#FFFFFF'
};

const DEFAULT_ASSETS = {
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
    const containerRef = useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState(0);

    // Dynamic branding from config
    const [studioName, setStudioName] = useState('Estúdio Búzios Digital');
    const [studioLogo, setStudioLogo] = useState(DEFAULT_ASSETS.logo);
    const [studioHero, setStudioHero] = useState(DEFAULT_ASSETS.heroImage);
    const [studioEmail, setStudioEmail] = useState('contato@buzios.digital');
    const [studioLocation, setStudioLocation] = useState('Búzios, RJ');

    const scrollToCalendar = () => {
        agendaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    useEffect(() => {
        // Load branding from config API
        pricingApi.getBusinessConfigPublic().then(({ config: cfg }) => {
            if (cfg.studio_name) setStudioName(String(cfg.studio_name));
            if (cfg.studio_logo_url) setStudioLogo(String(cfg.studio_logo_url));
            if (cfg.studio_hero_image) setStudioHero(String(cfg.studio_hero_image));
            if (cfg.studio_email) setStudioEmail(String(cfg.studio_email));
            if (cfg.studio_location) setStudioLocation(String(cfg.studio_location));
        }).catch(() => { });
    }, []);

    useEffect(() => {
        // SEO: title= and og: tags are set dynamically for this SPA page
        document.title = `${studioName} — O Melhor Estúdio de Podcast e Vídeo`;
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            metaDesc.setAttribute("content", `Produza seu podcast ou vídeo no ${studioName}. Tecnologia 4K, automação com IA e ambiente climatizado. Reserve agora.`);
        }

        // Update og: meta tags dynamically
        const ogUpdates: Record<string, string> = {
            'og:title': `${studioName} — O Melhor Estúdio de Podcast e Vídeo`,
            'og:description': `Produza seu podcast ou vídeo no ${studioName}. Tecnologia 4K, automação com IA e ambiente climatizado. Reserve agora.`,
        };
        Object.entries(ogUpdates).forEach(([property, content]) => {
            let tag = document.querySelector(`meta[property="${property}"]`);
            if (tag) {
                tag.setAttribute('content', content);
            }
        });

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


            // Agenda Section Entrance
            gsap.from('.agenda-feature', {
                scrollTrigger: {
                    trigger: agendaRef.current,
                    start: 'top 75%'
                },
                x: -30,
                opacity: 0,
                duration: 0.8,
                stagger: 0.15,
                ease: 'power3.out'
            });

            gsap.from('.mockup-calendar', {
                scrollTrigger: {
                    trigger: agendaRef.current,
                    start: 'top 70%'
                },
                y: 50,
                opacity: 0,
                duration: 1.2,
                ease: 'power4.out'
            });
        }, containerRef);

        return () => ctx.revert();
    }, [studioName]);

    return (
        <div ref={containerRef} aria-label="Página inicial" className="landing-root" style={{
            background: COLORS.bgDark,
            minHeight: '100vh',
            color: COLORS.white,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            overflowX: 'hidden',
            position: 'relative'
        }}>
            {/* Background Blobs for Visual Depth */}
            <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
                <div className="animate-blob" style={{ position: 'absolute', top: '-10%', left: '10%', width: '500px', height: '500px', background: COLORS.secondary, borderRadius: '50%', filter: 'blur(120px)', opacity: 0.25 }}></div>
                <div className="animate-blob animation-delay-2000" style={{ position: 'absolute', top: '20%', right: '-10%', width: '600px', height: '600px', background: COLORS.primary, borderRadius: '50%', filter: 'blur(150px)', opacity: 0.15 }}></div>
                <div className="animate-blob animation-delay-4000" style={{ position: 'absolute', bottom: '-20%', left: '30%', width: '800px', height: '800px', background: COLORS.accent, borderRadius: '50%', filter: 'blur(180px)', opacity: 0.1 }}></div>
            </div>

            <AmbientBackground />
            
            {/* Header / Navbar */}
            <header style={{
                position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
                padding: '20px 8%',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: 'rgba(0, 30, 38, 0.65)',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                borderBottom: '1px solid rgba(255,255,255,0.05)'
            }}>
                <nav style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <img
                            src={studioLogo}
                            alt={studioName}
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
                            boxShadow: '0 8px 30px rgba(17, 129, 155, 0.3)'
                        }}>
                            RESERVAR AGORA
                        </button>
                    </div>

                    <style>{`
                        @media (max-width: 768px) {
                            .nav-desktop { display: none !important; }
                            .hero-text h1 { font-size: clamp(2.5rem, 10vw, 3.5rem) !important; letter-spacing: -1.5px !important; }
                        }
                        @keyframes blob {
                            0% { transform: translate(0px, 0px) scale(1); }
                            33% { transform: translate(30px, -50px) scale(1.1); }
                            66% { transform: translate(-20px, 20px) scale(0.9); }
                            100% { transform: translate(0px, 0px) scale(1); }
                        }
                        .animate-blob { animation: blob 10s infinite alternate cubic-bezier(0.4, 0, 0.2, 1); }
                        .animation-delay-2000 { animation-delay: 2s; }
                        .animation-delay-4000 { animation-delay: 4s; }
                        
                        .btn-hover-scale { transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease; }
                        .btn-hover-scale:hover { transform: scale(1.05); box-shadow: 0 15px 35px rgba(17, 129, 155, 0.4); }
                        
                        @keyframes pulse-ring {
                            0% { box-shadow: 0 0 0 0 rgba(17, 129, 155, 0.5); transform: scale(1); }
                            70% { box-shadow: 0 0 0 20px rgba(17, 129, 155, 0); transform: scale(1.05); }
                            100% { box-shadow: 0 0 0 0 rgba(17, 129, 155, 0); transform: scale(1); }
                        }
                        .play-btn-pulse { animation: pulse-ring 2.5s infinite; transition: transform 0.3s ease; }
                        .play-btn-pulse:hover { transform: scale(1.1); animation-play-state: paused; }

                        .glass-mockup {
                            background: rgba(0, 46, 56, 0.4);
                            backdrop-filter: blur(24px);
                            -webkit-backdrop-filter: blur(24px);
                            border: 1px solid rgba(255,255,255,0.1);
                            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.1);
                            border-radius: 32px;
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
                            <button className="btn btn-hover-scale" style={{
                                background: COLORS.white, color: COLORS.bgDark, borderRadius: '14px',
                                padding: '18px 40px', fontSize: '1.05rem', fontWeight: 800, border: 'none',
                                boxShadow: '0 10px 30px rgba(0,0,0,0.2)', cursor: 'pointer', zIndex: 1
                            }} onClick={scrollToCalendar}>
                                INICIAR PROJETO
                            </button>
                            <div onClick={() => setIsVideoModalOpen(true)} className="group" style={{ display: 'flex', alignItems: 'center', gap: '14px', cursor: 'pointer', fontWeight: 700, zIndex: 1 }}>
                                <div className="play-btn-pulse" style={{ width: '54px', height: '54px', borderRadius: '50%', background: 'rgba(17, 129, 155, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${COLORS.primary}` }}>
                                    <PlayCircle size={28} style={{ color: COLORS.white }} />
                                </div>
                                CONHECER ESPAÇO
                            </div>
                        </div>
                    </div>

                    <div className="hero-image-container glass-mockup" style={{
                        position: 'relative',
                        width: '100%',
                        aspectRatio: '16 / 11',
                        padding: '12px',
                        transform: 'translateZ(0)'
                    }}>
                        <div style={{ width: '100%', height: '100%', borderRadius: '24px', overflow: 'hidden', position: 'relative' }}>
                            <img
                                src={studioHero}
                                className="hero-photo"
                                alt={studioName}
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to top, rgba(0,30,38,0.6), transparent)' }} />
                            <div style={{ position: 'absolute', bottom: '24px', left: '24px', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', padding: '12px 20px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.1)' }}>
                                <div style={{ fontSize: '0.8rem', opacity: 0.7, letterSpacing: '1px' }}>LOCALIZAÇÃO</div>
                                <div style={{ fontWeight: 700 }}>{studioLocation}</div>
                            </div>
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
                                    <div key={i} className="agenda-feature" style={{ display: 'flex', gap: '16px', background: 'rgba(255,255,255,0.03)', padding: '16px', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg, #11819B, #096E85)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: '0 4px 10px rgba(17, 129, 155, 0.3)' }}>
                                            <CheckCircle2 size={16} color="#fff" />
                                        </div>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '1.05rem', color: COLORS.white }}>{item.t}</div>
                                            <div style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.5)', marginTop: '4px' }}>{item.d}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Live Calendar Grid */}
                        <div className="mockup-calendar glass-mockup" style={{ flex: 1, minWidth: '320px', padding: '16px', overflow: 'hidden' }}>
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
                    <img src={studioLogo} alt={studioName} style={{ height: '28px', marginBottom: '24px' }} />
                    <p style={{ maxWidth: '300px', color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>Excelência e inovação em produção audiovisual e estratégica digital.</p>
                </div>
                <div style={{ display: 'flex', gap: '80px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        <span style={{ fontWeight: 700 }}>CONTATO</span>
                        <span style={{ opacity: 0.5 }}>(22) 3301-5850</span>
                        <span style={{ opacity: 0.5 }}>{studioEmail}</span>
                    </div>
                </div>
            </footer>
        </div>
    );
}
