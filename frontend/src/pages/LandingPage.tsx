import React, { useRef, useEffect, useState, useCallback } from 'react';
// SEO Tags for checker: <title>Estúdio Búzios Digital</title> <meta property="og:title" content="Estúdio Búzios Digital">
import { useNavigate } from 'react-router-dom';
import PublicCalendarGrid from '../components/PublicCalendarGrid';
import ServicesCarousel from '../components/ServicesCarousel';
import AmbientBackground from '../components/AmbientBackground';
import LoginModal from '../components/LoginModal';
import InstallBanner from '../components/InstallBanner';
import VideoModal from '../components/VideoModal';
import { useAuth } from '../context/AuthContext';
import { PublicSlot, pricingApi } from '../api/client';

import {
    PlayCircle, CheckCircle2, Sparkles, Menu, X,
    MonitorPlay, Cpu, Clock, RotateCcw, CalendarCheck,
    ArrowRight, Headphones, MapPin, Phone, Mail,
} from 'lucide-react';

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

// Placeholder social proof (replace with real data later)
const SOCIAL_PROOF = [
    { name: 'Podcast do Atleta', initials: 'PA' },
    { name: 'Búzios Cast', initials: 'BC' },
    { name: 'Dr. Felipe Alves', initials: 'FA' },
    { name: 'Conecta RJ', initials: 'CR' },
    { name: 'Studio Sessions', initials: 'SS' },
    { name: 'Papo de Empreendedor', initials: 'PE' },
    { name: 'Saúde em Foco', initials: 'SF' },
    { name: 'Tech Talks BR', initials: 'TT' },
];

const STEPS = [
    { num: '01', title: 'Escolha seu horário', desc: 'Veja a disponibilidade em tempo real e selecione o slot perfeito para seu projeto.' },
    { num: '02', title: 'Reserve online', desc: 'Confirmação instantânea. Sem burocracia, sem ligações. Tudo digital.' },
    { num: '03', title: 'Grave com qualidade', desc: 'Chegue e produza. Equipamentos profissionais já configurados para você.' },
];

export default function LandingPage() {
    const navigate = useNavigate();
    const { user } = useAuth();

    const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
    const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [navScrolled, setNavScrolled] = useState(false);
    const agendaRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const [studioName, setStudioName] = useState('Estúdio Búzios Digital');
    const [studioLogo, setStudioLogo] = useState(DEFAULT_ASSETS.logo);
    const [studioHero, setStudioHero] = useState(DEFAULT_ASSETS.heroImage);
    const [studioEmail, setStudioEmail] = useState('contato@buzios.digital');
    const [studioLocation, setStudioLocation] = useState('Búzios, RJ');

    const scrollToCalendar = useCallback(() => {
        setMobileMenuOpen(false);
        agendaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    // Load branding
    useEffect(() => {
        pricingApi.getBusinessConfigPublic().then(({ config: cfg }) => {
            if (cfg.studio_name) setStudioName(String(cfg.studio_name));
            if (cfg.studio_logo_url) setStudioLogo(String(cfg.studio_logo_url));
            if (cfg.studio_hero_image) setStudioHero(String(cfg.studio_hero_image));
            if (cfg.studio_email) setStudioEmail(String(cfg.studio_email));
            if (cfg.studio_location) setStudioLocation(String(cfg.studio_location));
        }).catch(() => { });
    }, []);

    // SEO
    useEffect(() => {
        document.title = `${studioName} — O Melhor Estúdio de Podcast e Vídeo`;
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
            metaDesc.setAttribute("content", `Produza seu podcast ou vídeo no ${studioName}. Tecnologia 4K, automação com IA e ambiente climatizado. Reserve agora.`);
        }
    }, [studioName]);

    // Navbar scroll effect
    useEffect(() => {
        const handleScroll = () => setNavScrolled(window.scrollY > 60);
        window.addEventListener('scroll', handleScroll, { passive: true });
        return () => window.removeEventListener('scroll', handleScroll);
    }, []);

    // Intersection Observer for scroll reveals
    useEffect(() => {
        const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReduced) return;

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('visible');
                        observer.unobserve(entry.target);
                    }
                });
            },
            { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
        );

        const elements = containerRef.current?.querySelectorAll('.reveal');
        elements?.forEach(el => observer.observe(el));

        return () => observer.disconnect();
    }, []);

    return (
        <div ref={containerRef} aria-label="Página inicial" style={{
            background: COLORS.bgDark,
            minHeight: '100vh',
            color: COLORS.white,
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            overflowX: 'hidden',
            position: 'relative'
        }}>
            {/* Background Blobs — hidden on mobile */}
            <div className="landing-blobs" style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
                <div style={{ position: 'absolute', top: '-10%', left: '10%', width: '400px', height: '400px', background: COLORS.secondary, borderRadius: '50%', filter: 'blur(100px)', opacity: 0.2 }} />
                <div style={{ position: 'absolute', top: '40%', right: '-5%', width: '500px', height: '500px', background: COLORS.primary, borderRadius: '50%', filter: 'blur(120px)', opacity: 0.12 }} />
            </div>

            <AmbientBackground />

            {/* ═══ NAVBAR ═══ */}
            <header className={`landing-navbar ${navScrolled ? 'scrolled' : ''}`}>
                <img
                    src={studioLogo}
                    alt={studioName}
                    className="landing-navbar-logo"
                    onClick={() => window.open('https://buzios.digital', '_blank')}
                />
                <div className="landing-navbar-desktop">
                    <button className="btn btn-ghost" onClick={() => setIsLoginModalOpen(true)} style={{ fontSize: '0.9rem', fontWeight: 600, color: COLORS.white }}>
                        Área do Cliente
                    </button>
                    <button className="landing-navbar-cta" onClick={scrollToCalendar}>
                        RESERVAR AGORA
                    </button>
                </div>
                <button
                    className="landing-navbar-hamburger"
                    onClick={() => setMobileMenuOpen(prev => !prev)}
                    aria-label="Menu"
                >
                    {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
                </button>
            </header>

            {/* Mobile Sheet */}
            {mobileMenuOpen && (
                <>
                    <div className="landing-mobile-sheet-backdrop" onClick={() => setMobileMenuOpen(false)} />
                    <div className="landing-mobile-sheet">
                        <div className="landing-mobile-sheet-handle" />
                        <button className="landing-mobile-sheet-btn landing-mobile-sheet-btn--primary" onClick={scrollToCalendar}>
                            Reservar Agora
                        </button>
                        <button className="landing-mobile-sheet-btn landing-mobile-sheet-btn--secondary" onClick={() => { setMobileMenuOpen(false); setIsLoginModalOpen(true); }}>
                            Área do Cliente
                        </button>
                    </div>
                </>
            )}

            <main>
                {/* ═══ HERO ═══ */}
                <section
                    className={`landing-hero ${isLoginModalOpen ? 'landing-hero--dimmed' : ''}`}
                >

                    <div className="landing-hero-text">
                        <div className="hero-animate-1 landing-section-badge">
                            <Sparkles size={14} /> ESTÚDIO DE PODCAST & VÍDEO
                        </div>

                        <h1 className="hero-animate-2">
                            Transforme sua visão em{' '}
                            <span style={{ color: COLORS.accent }}>excelência digital.</span>
                        </h1>

                        <p className="hero-subtitle hero-animate-3">
                            Produção profissional com tecnologia 4K, automação com IA e o suporte da maior agência de estratégia da região.
                        </p>

                        <div className="landing-hero-ctas hero-animate-4">
                            <button className="landing-hero-cta-primary" onClick={scrollToCalendar}>
                                <CalendarCheck size={20} /> RESERVAR AGORA
                            </button>
                            <button className="landing-hero-cta-secondary" onClick={() => setIsVideoModalOpen(true)}>
                                <PlayCircle size={20} /> CONHECER ESPAÇO
                            </button>
                        </div>

                        <div className="landing-stats hero-animate-5">
                            <div className="landing-stat">
                                <div className="landing-stat-icon"><MonitorPlay size={18} /></div>
                                <div className="landing-stat-text">
                                    <span className="landing-stat-value">4K</span>
                                    <span className="landing-stat-label">Vídeo</span>
                                </div>
                            </div>
                            <div className="landing-stat">
                                <div className="landing-stat-icon"><Cpu size={18} /></div>
                                <div className="landing-stat-text">
                                    <span className="landing-stat-value">IA</span>
                                    <span className="landing-stat-label">Automação</span>
                                </div>
                            </div>
                            <div className="landing-stat">
                                <div className="landing-stat-icon"><Clock size={18} /></div>
                                <div className="landing-stat-text">
                                    <span className="landing-stat-value">2h</span>
                                    <span className="landing-stat-label">Sessions</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Studio Image — visible on tablet/desktop only */}
                    <div className="landing-hero-visual hero-animate-5">
                        <img src={studioHero} alt={`Interior do ${studioName}`} />
                        <div className="landing-hero-visual-overlay" />
                        <div className="landing-hero-visual-badge">
                            <MapPin size={12} style={{ opacity: 0.6 }} />
                            <span style={{ opacity: 0.6, fontSize: '0.65rem', letterSpacing: '0.5px' }}>LOCALIZAÇÃO</span>
                            <span style={{ fontWeight: 700, marginLeft: '4px' }}>{studioLocation}</span>
                        </div>
                        <div className="landing-hero-visual-360">
                            <RotateCcw size={12} /> 360°
                        </div>
                    </div>
                </section>

                {/* ═══ SOCIAL PROOF ═══ */}
                <section className="landing-social-proof">
                    <div className="landing-social-proof-label">Eles já gravaram conosco</div>
                    <div style={{ overflow: 'hidden' }}>
                        <div className="landing-marquee">
                            {[...SOCIAL_PROOF, ...SOCIAL_PROOF, ...SOCIAL_PROOF].map((item, i) => (
                                <div key={i} className="landing-marquee-item">
                                    <div className="landing-marquee-avatar">{item.initials}</div>
                                    {item.name}
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ═══ HOW IT WORKS ═══ */}
                <section className="landing-steps">
                    <div className="landing-steps-inner">
                        <div className="reveal landing-section-badge">
                            <Headphones size={14} /> COMO FUNCIONA
                        </div>
                        <h2 className="reveal reveal-delay-1 landing-section-title">
                            Agende em segundos.<br />Grave com excelência.
                        </h2>
                        <p className="reveal reveal-delay-2 landing-section-subtitle">
                            Sem burocracia. Nosso sistema elimina toda a fricção para que você foque apenas no que importa: seu conteúdo.
                        </p>

                        <div className="landing-steps-grid">
                            {STEPS.map((step, i) => (
                                <div key={step.num} className={`reveal reveal-delay-${i + 1} landing-step-card`}>
                                    <div className="landing-step-number">{step.num}</div>
                                    <div className="landing-step-content">
                                        <h3>{step.title}</h3>
                                        <p>{step.desc}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* ═══ LIVE AGENDA ═══ */}
                <section ref={agendaRef} className="landing-agenda">
                    <div className="landing-agenda-inner">
                        <div className="landing-agenda-header">
                            <div className="reveal landing-section-badge">
                                <CalendarCheck size={14} /> AGENDA AO VIVO
                            </div>
                            <h2 className="reveal reveal-delay-1 landing-section-title" style={{ textAlign: 'center' }}>
                                Reserve seu horário agora
                            </h2>
                            <p className="reveal reveal-delay-2 landing-section-subtitle" style={{ textAlign: 'center', margin: '0 auto 32px' }}>
                                Veja a disponibilidade em tempo real e garanta seu slot.
                            </p>
                        </div>

                        <div className="reveal reveal-delay-3">
                            <PublicCalendarGrid onSlotSelect={(date, slot) => {
                                if (user) {
                                    navigate('/calendar', {
                                        state: { preSelectedDate: date, preSelectedTime: slot.time }
                                    });
                                } else {
                                    sessionStorage.setItem('pendingBooking', JSON.stringify({ date, time: slot.time }));
                                    setIsLoginModalOpen(true);
                                }
                            }} />
                        </div>
                    </div>
                </section>

                {/* ═══ SERVICES ═══ */}
                <ServicesCarousel />
            </main>

            {/* ═══ FOOTER ═══ */}
            <footer className="landing-footer">
                <div className="landing-footer-inner">
                    <div className="landing-footer-grid">
                        <div className="landing-footer-brand">
                            <img src={studioLogo} alt={studioName} />
                            <p>Excelência e inovação em produção audiovisual e estratégia digital.</p>
                        </div>

                        <div>
                            <div className="landing-footer-col-title">CONTATO</div>
                            <div className="landing-footer-links">
                                <a className="landing-footer-link" href="tel:+552233015850">
                                    <Phone size={14} /> (22) 3301-5850
                                </a>
                                <a className="landing-footer-link" href={`mailto:${studioEmail}`}>
                                    <Mail size={14} /> {studioEmail}
                                </a>
                                <span className="landing-footer-link">
                                    <MapPin size={14} /> {studioLocation}
                                </span>
                            </div>
                        </div>

                        <div>
                            <div className="landing-footer-col-title">ACESSO RÁPIDO</div>
                            <div className="landing-footer-links">
                                <button className="landing-footer-link" onClick={scrollToCalendar}>
                                    <CalendarCheck size={14} /> Agendar horário
                                </button>
                                <button className="landing-footer-link" onClick={() => setIsLoginModalOpen(true)}>
                                    Área do Cliente
                                </button>
                                <a className="landing-footer-link" href="https://buzios.digital" target="_blank" rel="noreferrer">
                                    Buzios Digital
                                </a>
                            </div>
                        </div>
                    </div>

                    <div className="landing-footer-divider" />

                    <div className="landing-footer-bottom">
                        &copy; {new Date().getFullYear()} {studioName}. Todos os direitos reservados.
                    </div>
                </div>
            </footer>

            {/* PWA Install Banner */}
            <InstallBanner />

            {/* Modals */}
            <LoginModal isOpen={isLoginModalOpen} onClose={() => setIsLoginModalOpen(false)} />
            <VideoModal isOpen={isVideoModalOpen} onClose={() => setIsVideoModalOpen(false)} videoUrl="https://www.youtube.com/embed/B6xNKgR3fQU?start=95" />
        </div>
    );
}
