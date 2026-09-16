import { useState, useEffect } from 'react';
import { pricingApi } from '../../../api/client';
import { formatBRL } from '../../../utils/format';
import { History, ArrowRight } from 'lucide-react';

interface FeeRow { effectiveFrom: string; feePct: number; feeFixedCents: number }
type HistoryMap = Record<string, FeeRow[]>;
type CurrentMap = Record<string, { pct: number; fixedCents: number }>;

// Rótulos amigáveis dos provedores versionados (mesma ordem do backend FEE_PROVIDERS).
const PROVIDER_META: { key: string; label: string }[] = [
    { key: 'STRIPE', label: 'Stripe · Cartão' },
    { key: 'CORA', label: 'Cora · PIX/Boleto' },
];

const isEpoch = (iso: string) => new Date(iso).getUTCFullYear() < 2000; // marco retroativo = "Início"
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtRate = (pct: number, fixedCents: number) =>
    pct > 0 ? `${pct.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% + ${formatBRL(fixedCents)}` : formatBRL(fixedCents);

interface Props {
    /** Muda quando as taxas são salvas, para recarregar o histórico. */
    refreshKey?: number;
}

export default function GatewayFeeTimeline({ refreshKey }: Props) {
    const [history, setHistory] = useState<HistoryMap>({});
    const [current, setCurrent] = useState<CurrentMap>({});
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;
        pricingApi.getFeeHistory()
            .then(res => { if (alive) { setHistory(res.history || {}); setCurrent(res.current || {}); setLoaded(true); } })
            .catch(() => { /* silencioso: complemento informativo; num refetch mantém o que já estava na tela */ });
        return () => { alive = false; };
    }, [refreshKey]);

    // Silencioso até a 1ª carga concluir. Depois NÃO desmonta em recargas (não pisca ao salvar a taxa).
    if (!loaded) return null;

    return (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px dashed var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <History size={15} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
                <h4 style={{ fontSize: '0.8125rem', fontWeight: 700, margin: 0 }}>Histórico de taxas</h4>
            </div>
            <p style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', margin: '0 0 14px' }}>
                O relatório usa a taxa vigente na data de cada pagamento — mudar a taxa aqui não altera os fechamentos passados.
            </p>

            <div style={{ display: 'grid', gap: 14 }}>
                {PROVIDER_META.map(pm => {
                    const rows = history[pm.key] || [];
                    const cur = current[pm.key];
                    return (
                        <div key={pm.key}>
                            <div style={{ fontSize: '0.6875rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 6 }}>
                                {pm.label}
                            </div>

                            {rows.length === 0 ? (
                                <FeeLine
                                    period="Sem alterações registradas"
                                    rate={cur ? fmtRate(cur.pct, cur.fixedCents) : '—'}
                                    vigente
                                />
                            ) : (
                                rows.map((r, i) => {
                                    const next = rows[i + 1];
                                    const from = isEpoch(r.effectiveFrom) ? 'Início' : fmtDate(r.effectiveFrom);
                                    const to = next ? fmtDate(next.effectiveFrom) : 'agora';
                                    return (
                                        <FeeLine
                                            key={r.effectiveFrom + i}
                                            period={`${from} → ${to}`}
                                            rate={fmtRate(r.feePct, r.feeFixedCents)}
                                            vigente={!next}
                                        />
                                    );
                                })
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function FeeLine({ period, rate, vigente }: { period: string; rate: string; vigente?: boolean }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '7px 12px', borderRadius: 8, marginBottom: 6,
            background: vigente ? 'rgba(16,185,129,0.07)' : 'var(--bg-card)',
            border: `1px solid ${vigente ? 'rgba(16,185,129,0.28)' : 'var(--border-default)'}`,
        }}>
            <ArrowRight size={12} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{period}</span>
            <span style={{ marginLeft: 'auto', fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>{rate}</span>
            {vigente && (
                <span style={{ fontSize: '0.625rem', fontWeight: 700, color: 'var(--success)', background: 'rgba(16,185,129,0.12)', padding: '2px 7px', borderRadius: 999 }}>
                    vigente
                </span>
            )}
        </div>
    );
}
