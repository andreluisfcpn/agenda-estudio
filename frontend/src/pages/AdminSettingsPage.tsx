import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    Settings,
    Building2,
    Clock,
    Wallet,
    ScrollText,
    Sparkles,
    CreditCard,
    Plug,
    Cloud,
    ChevronLeft,
    ChevronRight,
    type LucideIcon,
} from 'lucide-react';
import { useDragScroll } from '../hooks/useDragScroll';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import SettingsBusinessConfigSection from '../components/admin/settings/SettingsBusinessConfigSection';
import SettingsTiersSection from '../components/admin/settings/SettingsTiersSection';
import SettingsPaymentMethodsSection from '../components/admin/settings/SettingsPaymentMethodsSection';
import SettingsServicesSection from '../components/admin/settings/SettingsServicesSection';
import IntegrationSettings from '../components/IntegrationSettings';

type SectionId =
    | 'gerais'
    | 'horarios'
    | 'financeiro'
    | 'politicas'
    | 'servicos'
    | 'pagamentos'
    | 'ambiente'
    | 'integracoes';

interface SectionDef {
    id: SectionId;
    label: string;
    icon: LucideIcon;
    render: () => React.ReactNode;
}

/**
 * Each section is fully self-contained (owns its own fetch + dirty flag +
 * save bar). Switching sections unmounts the previous one — there is no
 * shared cross-section state, mirroring the legacy per-tab behavior.
 */
const SECTIONS: SectionDef[] = [
    {
        id: 'gerais',
        label: 'Gerais',
        icon: Building2,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['studio']}
                title="Estúdio & Branding"
                subtitle="Nome, logo, e-mail e imagens do estúdio."
            />
        ),
    },
    {
        id: 'horarios',
        label: 'Horários',
        icon: Clock,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['schedule']}
                title="Horários & Grade"
                subtitle="Slots de atendimento, dias de funcionamento e duração dos blocos."
            />
        ),
    },
    {
        id: 'financeiro',
        label: 'Financeiro',
        icon: Wallet,
        render: () => (
            <div style={{ display: 'grid', gap: '32px' }}>
                <SettingsTiersSection />
                <SettingsBusinessConfigSection
                    groups={['plans', 'gateway', 'payments']}
                    title="Planos, Taxas & Gateway"
                    subtitle="Descontos por fidelidade, taxas de cartão/PIX e taxas de gateway."
                    stackedSaveBar
                />
            </div>
        ),
    },
    {
        id: 'politicas',
        label: 'Políticas',
        icon: ScrollText,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['policies']}
                title="Políticas Operacionais"
                subtitle="Janelas de tempo, multas e restrições de agendamento."
            />
        ),
    },
    {
        id: 'servicos',
        label: 'Serviços',
        icon: Sparkles,
        render: () => <SettingsServicesSection />,
    },
    {
        id: 'pagamentos',
        label: 'Pagamentos',
        icon: CreditCard,
        render: () => <SettingsPaymentMethodsSection />,
    },
    {
        id: 'ambiente',
        label: 'Ambiente',
        icon: Cloud,
        render: () => (
            <SettingsBusinessConfigSection
                groups={['ambient']}
                title="Ambiente do Hero"
                subtitle="Animação por aba + clima/dia-noite no topo das telas do cliente. Defina a cidade do clima."
            />
        ),
    },
    {
        id: 'integracoes',
        label: 'Integrações',
        icon: Plug,
        render: () => <IntegrationSettings />,
    },
];

const DEFAULT_SECTION: SectionId = 'gerais';

export default function AdminSettingsPage() {
    const [searchParams, setSearchParams] = useSearchParams();
    const { ref: railRef, showLeft, showRight, scrollByPage } = useDragScroll<HTMLElement>();

    const activeId: SectionId = useMemo(() => {
        const sec = searchParams.get('sec') as SectionId | null;
        return SECTIONS.some(s => s.id === sec) ? (sec as SectionId) : DEFAULT_SECTION;
    }, [searchParams]);

    const active = SECTIONS.find(s => s.id === activeId) ?? SECTIONS[0];

    const goToSection = (id: SectionId) => {
        setSearchParams(prev => {
            const next = new URLSearchParams(prev);
            next.set('sec', id);
            return next;
        });
    };

    return (
        <div>
            <AdminPageHeader
                icon={Settings}
                title="Configurações"
                subtitle="Ajustes do sistema do estúdio"
            />

            <div className="admin-settings">
                {/* ── Sub-nav: hidden on desktop (driven by the sidebar's expandable
                       "Configurações"); shown as scrollable pills on mobile (sidebar hidden).
                       Wrapper hosts the side arrows + drag-to-scroll affordances. ── */}
                <div className="admin-settings-rail-wrap scrollrow-wrap">
                    {showLeft && (
                        <button
                            type="button"
                            className="scrollrow-arrow scrollrow-arrow--left"
                            aria-label="Rolar seções para a esquerda"
                            onClick={() => scrollByPage(-1)}
                            tabIndex={-1}
                        >
                            <ChevronLeft size={16} />
                        </button>
                    )}
                    <nav
                        ref={railRef}
                        className="admin-settings-rail admin-settings-rail--mobile-only scrollrow-track"
                        aria-label="Seções de configurações"
                    >
                        {SECTIONS.map(section => {
                            const Icon = section.icon;
                            const isActive = section.id === activeId;
                            return (
                                <button
                                    key={section.id}
                                    type="button"
                                    className={`admin-settings-rail-item ${isActive ? 'admin-settings-rail-item--active' : ''}`}
                                    aria-current={isActive ? 'page' : undefined}
                                    onClick={() => goToSection(section.id)}
                                >
                                    <span className="admin-settings-rail-icon">
                                        <Icon size={18} strokeWidth={1.8} />
                                    </span>
                                    {section.label}
                                </button>
                            );
                        })}
                    </nav>
                    {showRight && (
                        <button
                            type="button"
                            className="scrollrow-arrow scrollrow-arrow--right scrollrow-arrow--pulse"
                            aria-label="Rolar seções para a direita"
                            onClick={() => scrollByPage(1)}
                            tabIndex={-1}
                        >
                            <ChevronRight size={16} />
                        </button>
                    )}
                </div>

                {/* ── Active section only ── */}
                <div className="admin-settings-panel">
                    {active.render()}
                </div>
            </div>
        </div>
    );
}
