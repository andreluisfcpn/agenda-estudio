import { useState } from 'react';
import { ContractWithStats, ContractBooking, PricingConfig } from '../../api/client';
import { Pause } from 'lucide-react';
import { DAY_NAMES } from '../../utils/format';
import AwaitingPaymentBanner from './AwaitingPaymentBanner';

export interface ContractCardProps {
    contract: ContractWithStats;
    planConfig?: PricingConfig;
    allAddons: { key: string; name: string }[];
    expanded: boolean;
    onToggle: () => void;
    onBookingClick: (b: ContractBooking) => void;
    statusLabel: (s: string) => string;
    canModify: (b: ContractBooking) => boolean;
    onRequestCancel?: (id: string, feeNote: string) => void;
    onBulkBooking?: () => void;
    isArchived?: boolean;
    isCancelled?: boolean;
    onPayContract?: () => void;
    onRenewContract?: () => void;
    onSubscribeContract?: () => void;
    onExpireContract?: () => void;
}

export default function ContractCard({
    contract: c, planConfig, allAddons, expanded, onToggle,
    onBookingClick, statusLabel, canModify, onRequestCancel,
    onBulkBooking, isArchived, isCancelled, onPayContract,
    onRenewContract, onSubscribeContract, onExpireContract
}: ContractCardProps) {
    const bookings: ContractBooking[] = c.bookings || [];
    const totalBookings = c.type === 'FIXO' ? c.durationMonths * 4 : c.totalBookings;
    const usedBookingsCount = c.type === 'FIXO' ? bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED').length : (c.flexCreditsTotal || 0) - (c.flexCreditsRemaining || 0);
    const usedPct = totalBookings > 0 ? Math.round((usedBookingsCount / totalBookings) * 100) : 0;
    const now = new Date();

    const pendingBookings = bookings.filter(b => {
        if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
        const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
        return bookingDateTime >= now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
    });
    const completedBookings = bookings.filter(b => {
        if (b.status === 'CANCELLED' || b.status === 'NAO_REALIZADO') return false;
        if (b.status === 'COMPLETED' || b.status === 'FALTA') return true;
        const bookingDateTime = new Date(`${b.date.split('T')[0]}T${b.startTime}:00`);
        return bookingDateTime < now && (b.status === 'RESERVED' || b.status === 'CONFIRMED');
    });

    const isAvulso = c.type === 'FLEX' && c.durationMonths === 1;

    const daysLeft = Math.ceil((new Date(c.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const isExpiring = c.status === 'ACTIVE' && !isAvulso && daysLeft >= 0 && daysLeft <= 15;

    return (
        <div className="card" style={{ position: 'relative', overflow: 'hidden', padding: 0 }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: c.type === 'FIXO' ? 'var(--tier-sabado)' : isAvulso ? 'var(--tier-comercial)' : 'var(--tier-audiencia)' }} />

            {/* Clickable header */}
            <div style={{ padding: '20px 24px', cursor: 'pointer', transition: 'background 0.15s' }}
                onClick={onToggle}
                onMouseOver={e => e.currentTarget.style.background = 'var(--bg-card-hover)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                            {isAvulso ? (
                                <span className="badge badge-active">AVULSO</span>
                            ) : (
                                <span className={`badge ${c.type === 'FIXO' ? 'badge-confirmed' : c.type === 'CUSTOM' ? 'badge-reserved' : 'badge-reserved'}`}>
                                    {c.type === 'FIXO' ? 'Plano Fixo' : c.type === 'CUSTOM' ? 'Personalizado' : 'Plano Flex'}
                                </span>
                            )}
                            <span className={`badge badge-${c.tier.toLowerCase()}`}>{c.tier}</span>
                            {c.status === 'ACTIVE' ? (
                                isArchived ? (
                                    <span className="badge" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}>FINALIZADO</span>
                                ) : (
                                    <>
                                        <span className="badge badge-active">ATIVO</span>
                                        {isExpiring && <span className="badge" style={{ background: 'rgba(217,119,6,0.1)', color: '#f59e0b', border: '1px solid rgba(217,119,6,0.2)' }}>VENCE EM {daysLeft} DIAS</span>}
                                    </>
                                )
                            ) : c.status === 'AWAITING_PAYMENT' ? (
                                <span className="badge" style={{ background: 'rgba(217,119,6,0.1)', color: '#f59e0b', border: '1px solid rgba(217,119,6,0.2)', animation: 'pulse 2s infinite' }}>AGUARDANDO PAGAMENTO</span>
                            ) : c.status === 'PENDING_CANCELLATION' ? (
                                <span className="badge" style={{ background: '#FFF8E1', color: '#F57F17', border: '1px solid #FFE082' }}>AGUARDANDO CANCELAMENTO</span>
                            ) : c.status === 'PAUSED' ? (
                                <span className="badge badge-paused">PAUSADO</span>
                            ) : (
                                <span className="badge badge-cancelled">{c.status === 'EXPIRED' ? 'EXPIRADO' : 'CANCELADO'}</span>
                            )}
                        </div>
                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                            {isAvulso ? (
                                <>
                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}<strong>uma gravação</strong>
                                    {c.bookings?.[0]?.addOns && c.bookings[0].addOns.length > 0 && (
                                        <>
                                            {' · '}
                                            <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>
                                                Inclusos: {c.bookings[0].addOns.map(ak => allAddons.find(a => a.key === ak)?.name || ak).join(', ')}
                                            </span>
                                        </>
                                    )}
                                </>
                            ) : (
                                <>
                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} — {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}{c.durationMonths} meses · Desconto <strong style={{ color: 'var(--tier-comercial)' }}>{c.discountPct}%</strong>
                                </>
                            )}
                        </div>
                        {c.type === 'FIXO' && (
                            <div style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Dia fixo: <strong>{c.fixedDayOfWeek !== null && c.fixedDayOfWeek !== undefined ? DAY_NAMES[c.fixedDayOfWeek] : '—'}</strong>
                                {c.fixedTime && <> · Horário: <strong>{c.fixedTime}</strong></>}
                            </div>
                        )}
                        {c.type === 'FLEX' && !isAvulso && (
                            <div style={{ marginTop: '6px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                Créditos: <strong>{c.flexCreditsRemaining ?? 0}</strong> restantes de <strong>{c.flexCreditsTotal ?? 0}</strong>
                            </div>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {c.contractUrl && (
                            <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm"
                                onClick={e => e.stopPropagation()}>Ver Contrato</a>
                        )}
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
                    </div>
                </div>

                {/* Awaiting Payment Banner */}
                {c.status === 'AWAITING_PAYMENT' && onPayContract && (
                    <AwaitingPaymentBanner
                        paymentDeadline={c.paymentDeadline || null}
                        onPay={onPayContract}
                        onExpire={onExpireContract}
                    />
                )}

                {/* Paused Banner */}
                {c.status === 'PAUSED' && (
                    <div style={{ background: 'rgba(217, 119, 6, 0.1)', border: '1px solid rgba(217, 119, 6, 0.2)', borderLeft: '3px solid #d97706', padding: '12px 16px', margin: '0 24px 16px 24px', borderRadius: 'var(--radius-sm)' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                            <Pause size={20} style={{ color: '#f59e0b' }} />
                            <div>
                                <h4 style={{ fontSize: '0.875rem', fontWeight: 700, color: '#d97706', marginBottom: '4px' }}>Contrato Pausado</h4>
                                <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)' }}>
                                    <strong>Motivo:</strong> {c.pauseReason || 'Não informado'}<br/>
                                    <strong>Retorno Previsto:</strong> {c.resumeDate ? new Date(c.resumeDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Indefinido'}
                                </p>
                                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '8px', fontStyle: 'italic' }}>
                                    Durante a pausa, novos agendamentos estão bloqueados. Retornaremos sua vigência acrescida dos dias parados.
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Consumption bar or Cancelled Stats */}
                {isCancelled ? (
                    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '12px', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--tier-sabado)' }} /> Gravações Realizadas</span>
                            <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>{completedBookings.length}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}><div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)' }} /> Gravações Canceladas</span>
                            <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>{totalBookings - completedBookings.length}</span>
                        </div>
                        <div style={{ marginTop: '4px', paddingTop: '8px', borderTop: '1px dashed var(--border-subtle)', fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                            Encerrado em: <strong>{new Date(c.endDate).toLocaleDateString('pt-BR')}</strong>
                        </div>
                    </div>
                ) : !isArchived ? (
                    <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Gravações</span>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{usedBookingsCount} / {totalBookings} episódios</span>
                        </div>
                        <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                            <div style={{
                                height: '100%', borderRadius: 4,
                                background: usedPct >= 100 ? 'var(--status-blocked)' : 'var(--status-available)',
                                width: `${Math.min(usedPct, 100)}%`, transition: 'width 0.5s ease',
                            }} />
                        </div>
                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                            {totalBookings - usedBookingsCount} restantes · {usedPct}% utilizado
                        </div>
                        
                        {/* Custom Contract Addon Progress Bars */}
                        {c.addonUsage && Object.entries(c.addonUsage).map(([addonKey, usage]) => {
                            const addonName = allAddons.find(a => a.key === addonKey)?.name || addonKey;
                            const usedAddonPct = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
                            return (
                                <div key={addonKey} style={{ marginTop: '14px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{addonName}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{usage.used} / {usage.limit} entregues (Ciclo Atual)</span>
                                    </div>
                                    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', borderRadius: 3,
                                            background: usedAddonPct >= 100 ? 'var(--tier-audiencia)' : 'var(--accent-primary)',
                                            width: `${Math.min(usedAddonPct, 100)}%`, transition: 'width 0.5s ease',
                                        }} />
                                    </div>
                                </div>
                            );
                        })}

                        {/* Legacy Fixed/Flex Addons */}
                        {!c.addonUsage && c.addOns?.filter(key => key !== 'GESTAO_SOCIAL').map(addonKey => {
                            const addonName = allAddons.find(a => a.key === addonKey)?.name || addonKey;
                            const usedAddonCount = bookings.filter(b => b.status !== 'NAO_REALIZADO' && b.status !== 'CANCELLED' && b.addOns?.includes(addonKey)).length;
                            const usedAddonPct = totalBookings > 0 ? Math.round((usedAddonCount / totalBookings) * 100) : 0;
                            return (
                                <div key={addonKey} style={{ marginTop: '14px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{addonName}</span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>{usedAddonCount} / {totalBookings} entregues</span>
                                    </div>
                                    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', borderRadius: 3,
                                            background: usedAddonPct >= 100 ? 'var(--status-blocked)' : 'var(--accent-primary)',
                                            width: `${Math.min(usedAddonPct, 100)}%`, transition: 'width 0.5s ease',
                                        }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}>
                            Todas as gravações realizadas
                        </span>
                    </div>
                )}
            </div>

            {/* Expanded */}
            {expanded && (
                <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '20px 24px', background: 'var(--bg-secondary)' }}>
                    {planConfig?.description && (
                        <div style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', fontSize: '0.8125rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginBottom: '16px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', marginBottom: '4px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Regras do Plano</div>
                            {planConfig.description}
                        </div>
                    )}

                    {/* Pending */}
                    {!isCancelled && (
                        <div style={{ marginBottom: '16px' }}>
                            <h4 style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                Agendamentos Realizados <span className="badge badge-reserved" style={{ fontSize: '0.65rem' }}>{pendingBookings.length}</span>
                            </h4>
                            {pendingBookings.length === 0 ? (
                                <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhum agendamento pendente.</div>
                            ) : (
                                <div className="stagger-enter" style={{ display: 'grid', gap: '6px' }}>
                                    {pendingBookings.map(b => (
                                        <div key={b.id}
                                            onClick={() => onBookingClick(b)}
                                            className="booking-row"
                                            role="button"
                                            tabIndex={0}
                                            aria-label={`Agendamento ${new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} ${b.startTime}`}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                <span style={{ fontWeight: 700 }}>
                                                    {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}
                                                </span>
                                                <span style={{ color: 'var(--text-secondary)' }}>{b.startTime} — {b.endTime}</span>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                {canModify(b) && c.status !== 'PAUSED' && <span style={{ fontSize: '0.65rem', color: 'var(--tier-audiencia)' }}>Gerenciar</span>}
                                                <span style={{ fontSize: '0.75rem' }}>{statusLabel(b.status)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Completed */}
                    <div>
                        <h4 style={{ fontSize: '0.8125rem', fontWeight: 700, marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            Gravações Realizadas <span className="badge badge-confirmed" style={{ fontSize: '0.65rem' }}>{completedBookings.length}</span>
                        </h4>
                        {completedBookings.length === 0 ? (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '8px 0' }}>Nenhuma gravação realizada ainda.</div>
                        ) : (
                            <div style={{ display: 'grid', gap: '6px' }}>
                                {completedBookings.map(b => (
                                    <div key={b.id}
                                        onClick={() => onBookingClick(b)}
                                        className="booking-row"
                                        role="button"
                                        tabIndex={0}
                                        style={{ opacity: 0.85 }}
                                        aria-label={`Gravação ${new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} ${b.startTime}`}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span style={{ fontWeight: 700 }}>
                                                {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}
                                            </span>
                                            <span style={{ color: 'var(--text-secondary)' }}>{b.startTime} — {b.endTime}</span>
                                        </div>
                                        <span style={{ fontSize: '0.75rem' }}>{statusLabel(b.status)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {c.status === 'ACTIVE' && (
                        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
                            {isExpiring && onRenewContract && (
                                <button className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '6px 12px', minHeight: '44px', background: 'var(--tier-comercial)', borderColor: 'var(--tier-comercial)', boxShadow: '0 4px 12px rgba(109, 40, 217, 0.3)' }}
                                    onClick={(e) => { e.stopPropagation(); onRenewContract(); }}>
                                    Renovar Contrato
                                </button>
                            )}
                            {!isAvulso && c.status === 'ACTIVE' && onSubscribeContract && (
                                <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '6px 12px', minHeight: '44px' }}
                                    onClick={(e) => { e.stopPropagation(); onSubscribeContract(); }}>
                                    Ativar Recorrência (Stripe)
                                </button>
                            )}
                            {c.type === 'FLEX' && (c.flexCreditsRemaining || 0) > 0 && onBulkBooking && (
                                <button className="btn btn-primary" style={{ fontSize: '0.75rem', padding: '6px 12px', minHeight: '44px' }}
                                    onClick={(e) => { e.stopPropagation(); onBulkBooking(); }}>
                                    Agendar Gravações Pendentes
                                </button>
                            )}
                            {onRequestCancel && (
                                <button className="btn" style={{ background: '#FFF0F0', color: '#D32F2F', border: '1px solid #FFCDD2', fontSize: '0.75rem', padding: '6px 12px', minHeight: '44px' }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRequestCancel(c.id, c.type === 'FIXO' ? '20% do valor correspondente aos meses/agendamentos que faltavam realizar.' : '20% do valor correspondente aos créditos não utilizados.');
                                    }}>
                                    Solicitar Cancelamento
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
