import { UserDetail } from '../../../api/client';
import { computeClientHealth } from '../../../utils/clientHealth';
import { formatBRL } from '../../../utils/format';

/** Resumo Financeiro + Health Score lado a lado (um único cálculo alimenta
 *  os dois cards — por isso não são componentes separados). */
export default function ClientHealthCards({ user }: { user: UserDetail }) {
    const h = computeClientHealth(user);

    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            {/* Financial Summary */}
            <div className="card" style={{ padding: '20px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>💰 Resumo Financeiro</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ padding: '12px', background: 'rgba(16,185,129,0.08)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Total Pago</div>
                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--success)', marginTop: '4px' }}>{formatBRL(h.paid)}</div>
                    </div>
                    <div style={{ padding: '12px', background: 'rgba(217,119,6,0.08)', borderRadius: 'var(--radius-sm)', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>Pendente</div>
                        <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--warning)', marginTop: '4px' }}>{formatBRL(h.pending)}</div>
                    </div>
                    {h.overdue > 0 && (
                        <div style={{ padding: '12px', background: 'rgba(220,38,38,0.08)', borderRadius: 'var(--radius-sm)', textAlign: 'center', gridColumn: 'span 2' }}>
                            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)' }}>⚠️ Vencido</div>
                            <div style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--danger)', marginTop: '4px' }}>{formatBRL(h.overdue)}</div>
                        </div>
                    )}
                </div>
                <div style={{ marginTop: '12px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {h.paymentsCount} pagamento{h.paymentsCount !== 1 ? 's' : ''} registrado{h.paymentsCount !== 1 ? 's' : ''}
                    {h.total > 0 && <> · {h.completed} sessão{h.completed !== 1 ? 'ões' : ''} concluída{h.completed !== 1 ? 's' : ''} de {h.total}</>}
                </div>
            </div>

            {/* Health Score */}
            <div className="card" style={{ padding: '20px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px' }}>🏥 Health Score</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                    {/* Circular gauge */}
                    <div style={{ position: 'relative', width: 80, height: 80, flexShrink: 0 }}>
                        <svg viewBox="0 0 36 36" style={{ width: 80, height: 80, transform: 'rotate(-90deg)' }}>
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke="var(--border-color)" strokeWidth="3" />
                            <circle cx="18" cy="18" r="15.5" fill="none" stroke={h.healthColor} strokeWidth="3"
                                strokeDasharray={`${h.healthScore * 0.97} 100`} strokeLinecap="round" />
                        </svg>
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.125rem', fontWeight: 800, color: h.healthColor }}>
                            {h.healthScore}
                        </div>
                    </div>
                    <div style={{ flex: 1, fontSize: '0.75rem' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.875rem', color: h.healthColor, marginBottom: '8px' }}>{h.healthLabel}</div>
                        <div style={{ display: 'grid', gap: '4px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text-muted)' }}>Pagamentos</span>
                                <span style={{ fontWeight: 600 }}>{Math.round(h.paymentScore)}%</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text-muted)' }}>Presença</span>
                                <span style={{ fontWeight: 600 }}>{Math.round(h.attendanceRate)}%</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text-muted)' }}>Contrato</span>
                                <span style={{ fontWeight: 600 }}>{h.contractScore}%</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <span style={{ color: 'var(--text-muted)' }}>Recência</span>
                                <span style={{ fontWeight: 600 }}>{h.recencyScore}%</span>
                            </div>
                            {h.faltas > 0 && <div style={{ color: 'var(--danger)', marginTop: '4px' }}>⚠ {h.faltas} falta{h.faltas > 1 ? 's' : ''}</div>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
