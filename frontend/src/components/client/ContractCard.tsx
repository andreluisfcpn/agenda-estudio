import { ContractWithStats, ContractBooking, PricingConfig } from '../../api/client';
import { Pause, ChevronDown } from 'lucide-react';
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

    const accentType = c.type === 'FIXO' ? 'fixo' : isAvulso ? 'avulso' : c.type === 'CUSTOM' ? 'custom' : 'flex';

    return (
        <div className="card contract-card">
            <div className={`contract-card__accent contract-card__accent--${accentType}`} />

            {/* Clickable header */}
            <div className="contract-card__header" onClick={onToggle}>
                <div className="contract-card__top-row">
                    <div>
                        <div className="contract-card__badges">
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
                                    <span className="badge badge-muted">FINALIZADO</span>
                                ) : (
                                    <>
                                        <span className="badge badge-active">ATIVO</span>
                                        {isExpiring && <span className="badge badge-expiring">VENCE EM {daysLeft} DIAS</span>}
                                    </>
                                )
                            ) : c.status === 'AWAITING_PAYMENT' ? (
                                <span className="badge badge-awaiting">AGUARDANDO PAGAMENTO</span>
                            ) : c.status === 'PENDING_CANCELLATION' ? (
                                <span className="badge badge-pending-cancel">AGUARDANDO CANCELAMENTO</span>
                            ) : c.status === 'PAUSED' ? (
                                <span className="badge badge-paused">PAUSADO</span>
                            ) : (
                                <span className="badge badge-cancelled">{c.status === 'EXPIRED' ? 'EXPIRADO' : 'CANCELADO'}</span>
                            )}
                        </div>
                        <div className="contract-card__meta">
                            {isAvulso ? (
                                <>
                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}<strong>uma gravação</strong>
                                    {c.bookings?.[0]?.addOns && c.bookings[0].addOns.length > 0 && (
                                        <>
                                            {' · '}
                                            <span className="contract-card__addons-text">
                                                Inclusos: {c.bookings[0].addOns.map(ak => allAddons.find(a => a.key === ak)?.name || ak).join(', ')}
                                            </span>
                                        </>
                                    )}
                                </>
                            ) : (
                                <>
                                    {new Date(c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} — {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}{c.durationMonths} meses · Desconto <strong className="contract-card__discount">{c.discountPct}%</strong>
                                </>
                            )}
                        </div>
                        {c.type === 'FIXO' && (
                            <div className="contract-card__detail">
                                Dia fixo: <strong>{c.fixedDayOfWeek !== null && c.fixedDayOfWeek !== undefined ? DAY_NAMES[c.fixedDayOfWeek] : '—'}</strong>
                                {c.fixedTime && <> · Horário: <strong>{c.fixedTime}</strong></>}
                            </div>
                        )}
                        {c.type === 'FLEX' && !isAvulso && (
                            <div className="contract-card__detail">
                                Créditos: <strong>{c.flexCreditsRemaining ?? 0}</strong> restantes de <strong>{c.flexCreditsTotal ?? 0}</strong>
                            </div>
                        )}
                    </div>
                    <div className="contract-card__end">
                        {c.contractUrl && (
                            <a href={c.contractUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm"
                                onClick={e => e.stopPropagation()}>Ver Contrato</a>
                        )}
                        <ChevronDown
                            size={16}
                            className={`contract-card__chevron ${expanded ? 'contract-card__chevron--open' : ''}`}
                        />
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
                    <div className="hold-banner" style={{ margin: '12px 0 0' }}>
                        <div className="hold-banner__content">
                            <Pause size={20} className="hold-banner__icon" />
                            <div style={{ flex: 1 }}>
                                <div className="hold-banner__title">Contrato Pausado</div>
                                <p className="hold-banner__desc">
                                    <strong>Motivo:</strong> {c.pauseReason || 'Não informado'}<br/>
                                    <strong>Retorno Previsto:</strong> {c.resumeDate ? new Date(c.resumeDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : 'Indefinido'}
                                </p>
                                <p className="contract-card__pause-note">
                                    Durante a pausa, novos agendamentos estão bloqueados. Retornaremos sua vigência acrescida dos dias parados.
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {/* Consumption bar or Cancelled Stats */}
                {isCancelled ? (
                    <div className="contract-card__cancelled-stats">
                        <div className="contract-card__cancelled-row">
                            <span className="contract-card__cancelled-label">
                                <span className="contract-card__dot contract-card__dot--done" /> Gravações Realizadas
                            </span>
                            <span className="contract-card__cancelled-value">{completedBookings.length}</span>
                        </div>
                        <div className="contract-card__cancelled-row">
                            <span className="contract-card__cancelled-label">
                                <span className="contract-card__dot contract-card__dot--cancelled" /> Gravações Canceladas
                            </span>
                            <span className="contract-card__cancelled-value">{totalBookings - completedBookings.length}</span>
                        </div>
                        <div className="contract-card__cancelled-footer">
                            Encerrado em: <strong>{new Date(c.endDate).toLocaleDateString('pt-BR')}</strong>
                        </div>
                    </div>
                ) : !isArchived ? (
                    <div className="contract-progress" style={{ padding: 0, marginTop: 12 }}>
                        <div className="contract-progress__header">
                            <span className="contract-progress__label-text">Gravações</span>
                            <span className="contract-progress__label-count">{usedBookingsCount} / {totalBookings} episódios</span>
                        </div>
                        <div className="contract-progress__bar-bg">
                            <div
                                className="contract-progress__bar-fill"
                                style={{
                                    background: usedPct >= 100 ? 'var(--status-blocked)' : 'var(--status-available)',
                                    width: `${Math.min(usedPct, 100)}%`,
                                }}
                            />
                        </div>
                        <div className="contract-progress__summary">
                            {totalBookings - usedBookingsCount} restantes · {usedPct}% utilizado
                        </div>
                        
                        {/* Custom Contract Addon Progress Bars */}
                        {c.addonUsage && Object.entries(c.addonUsage).map(([addonKey, usage]) => {
                            const addonName = allAddons.find(a => a.key === addonKey)?.name || addonKey;
                            const usedAddonPct = usage.limit > 0 ? Math.round((usage.used / usage.limit) * 100) : 0;
                            return (
                                <div key={addonKey} className="contract-progress__addon">
                                    <div className="contract-progress__header">
                                        <span className="contract-progress__label-text">{addonName}</span>
                                        <span className="contract-progress__label-count">{usage.used} / {usage.limit} entregues (Ciclo Atual)</span>
                                    </div>
                                    <div className="contract-progress__bar-bg contract-progress__bar-bg--sm">
                                        <div
                                            className="contract-progress__bar-fill"
                                            style={{
                                                background: usedAddonPct >= 100 ? 'var(--tier-audiencia)' : 'var(--accent-primary)',
                                                width: `${Math.min(usedAddonPct, 100)}%`,
                                            }}
                                        />
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
                                <div key={addonKey} className="contract-progress__addon">
                                    <div className="contract-progress__header">
                                        <span className="contract-progress__label-text">{addonName}</span>
                                        <span className="contract-progress__label-count">{usedAddonCount} / {totalBookings} entregues</span>
                                    </div>
                                    <div className="contract-progress__bar-bg contract-progress__bar-bg--sm">
                                        <div
                                            className="contract-progress__bar-fill"
                                            style={{
                                                background: usedAddonPct >= 100 ? 'var(--status-blocked)' : 'var(--accent-primary)',
                                                width: `${Math.min(usedAddonPct, 100)}%`,
                                            }}
                                        />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="contract-card__archived-note">
                        Todas as gravações realizadas
                    </div>
                )}
            </div>

            {/* Expanded */}
            {expanded && (
                <div className="contract-bookings">
                    {planConfig?.description && (
                        <div className="contract-bookings__rules">
                            <div className="contract-bookings__rules-label">Regras do Plano</div>
                            {planConfig.description}
                        </div>
                    )}

                    {/* Pending */}
                    {!isCancelled && (
                        <div className="contract-booking-group">
                            <h4 className="contract-booking-group__title">
                                Agendamentos Realizados <span className="badge badge-reserved">{pendingBookings.length}</span>
                            </h4>
                            {pendingBookings.length === 0 ? (
                                <div className="contract-bookings__empty">Nenhum agendamento pendente.</div>
                            ) : (
                                <div className="stagger-enter">
                                    {pendingBookings.map(b => (
                                        <div key={b.id}
                                            onClick={() => onBookingClick(b)}
                                            className="contract-booking-item"
                                            role="button"
                                            tabIndex={0}
                                            aria-label={`Agendamento ${new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} ${b.startTime}`}
                                        >
                                            <div>
                                                <div className="contract-booking-item__date">
                                                    {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}
                                                </div>
                                                <div className="contract-booking-item__time">{b.startTime} — {b.endTime}</div>
                                            </div>
                                            <div className="contract-booking-item__actions">
                                                {canModify(b) && c.status !== 'PAUSED' && <span className="contract-booking-item__manage">Gerenciar</span>}
                                                <span className="contract-booking-item__status">{statusLabel(b.status)}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Completed */}
                    <div className="contract-booking-group">
                        <h4 className="contract-booking-group__title">
                            Gravações Realizadas <span className="badge badge-confirmed">{completedBookings.length}</span>
                        </h4>
                        {completedBookings.length === 0 ? (
                            <div className="contract-bookings__empty">Nenhuma gravação realizada ainda.</div>
                        ) : (
                            <div>
                                {completedBookings.map(b => (
                                    <div key={b.id}
                                        onClick={() => onBookingClick(b)}
                                        className="contract-booking-item contract-booking-item--completed"
                                        role="button"
                                        tabIndex={0}
                                        aria-label={`Gravação ${new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} ${b.startTime}`}
                                    >
                                        <div>
                                            <div className="contract-booking-item__date">
                                                {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' })}
                                            </div>
                                            <div className="contract-booking-item__time">{b.startTime} — {b.endTime}</div>
                                        </div>
                                        <span className="contract-booking-item__status">{statusLabel(b.status)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {c.status === 'ACTIVE' && (
                        <div className="contract-actions">
                            {isExpiring && onRenewContract && (
                                <button className="btn btn-primary btn-sm contract-actions__renew"
                                    onClick={(e) => { e.stopPropagation(); onRenewContract(); }}>
                                    Renovar Contrato
                                </button>
                            )}
                            {!isAvulso && c.status === 'ACTIVE' && onSubscribeContract && (
                                <button className="btn btn-secondary btn-sm"
                                    onClick={(e) => { e.stopPropagation(); onSubscribeContract(); }}>
                                    Ativar Recorrência (Stripe)
                                </button>
                            )}
                            {c.type === 'FLEX' && (c.flexCreditsRemaining || 0) > 0 && onBulkBooking && (
                                <button className="btn btn-primary btn-sm"
                                    onClick={(e) => { e.stopPropagation(); onBulkBooking(); }}>
                                    Agendar Gravações Pendentes
                                </button>
                            )}
                            {onRequestCancel && (
                                <button className="btn btn-sm contract-actions__cancel"
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
