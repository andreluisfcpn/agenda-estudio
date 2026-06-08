import { Check, Sparkles } from 'lucide-react';
import { AddOnConfig } from '../../api/client';

interface ServicePanelContract {
    name: string;
    startDate: string | Date;
    endDate: string | Date;
    durationMonths: number;
    status: string;
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
            <div style={{ fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
        </div>
    );
}

/**
 * Detail panel for a standalone monthly SERVICO contract (no recordings): the service's
 * deliverables (from the add-on's benefits) plus duration/validity/renewal. Used by the
 * client ContractCard and the admin contract detail page. The payments list stays the
 * responsibility of the host (each already renders its own).
 */
export default function ServiceContractPanel({ contract, addon }: { contract: ServicePanelContract; addon?: AddOnConfig | null }) {
    let benefits: string[] = [];
    try {
        const parsed = addon?.benefits ? JSON.parse(addon.benefits) : [];
        if (Array.isArray(parsed)) benefits = parsed.filter((b: unknown): b is string => typeof b === 'string');
    } catch { /* ignore malformed */ }

    const start = new Date(contract.startDate);
    const end = new Date(contract.endDate);
    const daysLeft = Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const fmt = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });

    return (
        <div className="contract-booking-group">
            <h4 className="contract-booking-group__title">
                <Sparkles size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} /> Sobre o serviço
            </h4>

            {benefits.length > 0 && (
                <div style={{ display: 'grid', gap: 8, margin: '0 0 14px' }}>
                    {benefits.map(b => (
                        <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                            <Check size={15} style={{ flexShrink: 0, color: 'var(--accent-primary)' }} /> {b}
                        </div>
                    ))}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Stat label="Duração" value={`${contract.durationMonths} meses`} />
                <Stat label="Vigência" value={`${fmt(start)} – ${fmt(end)}`} />
                {contract.status === 'ACTIVE' && (
                    <Stat label={daysLeft >= 0 ? 'Renova em' : 'Venceu há'} value={`${Math.abs(daysLeft)} dia${Math.abs(daysLeft) === 1 ? '' : 's'}`} />
                )}
            </div>
        </div>
    );
}
