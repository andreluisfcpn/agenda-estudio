import { ContractWithStats, ContractBooking, PricingConfig, AddOnConfig, PaymentSummary } from '../../api/client';
import { Pause, ChevronDown, CalendarClock, CheckCircle2, Info, Sparkles, ChevronRight } from 'lucide-react';
import { DAY_NAMES, formatBRL } from '../../utils/format';
import { computeFlexState, flexWeekStatuses } from '../../utils/flexCredits';
import { useBusinessConfig } from '../../hooks/useBusinessConfig';
import ServiceLineItem from '../ui/ServiceLineItem';
import AwaitingPaymentBanner from './AwaitingPaymentBanner';
import ServiceContractPanel from './ServiceContractPanel';

// Client-facing payment status badges (reuses the shared badge classes).
const PAYMENT_LABEL: Record<string, { label: string; cls: string }> = {
    PAID: { label: 'Pago', cls: 'badge-confirmed' },
    PENDING: { label: 'Pendente', cls: 'badge-reserved' },
    FAILED: { label: 'Falhou', cls: 'badge-cancelled' },
    REFUNDED: { label: 'Estornado', cls: 'badge-muted' },
    CANCELLED: { label: 'Cancelado', cls: 'badge-cancelled' },
};

export interface ContractCardProps {
    contract: ContractWithStats;
    planConfig?: PricingConfig;
    allAddons: AddOnConfig[];
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
    onPayInstallment?: (payment: PaymentSummary) => void;
    onRenewContract?: () => void;
    onSubscribeContract?: () => void;
    onExpireContract?: () => void;
}

export default function ContractCard({
    contract: c, planConfig, allAddons, expanded, onToggle,
    onBookingClick, statusLabel, canModify, onRequestCancel,
    onBulkBooking, isArchived, isCancelled, onPayContract, onPayInstallment,
    onRenewContract, onSubscribeContract, onExpireContract
}: ContractCardProps) {
    const bookings: ContractBooking[] = c.bookings || [];
    const { get: getRule } = useBusinessConfig();
    const sessionsPerMonth = getRule('sessions_per_month');
    // Contract recurring services (accompany every recording). Per-episode = "valor por gravação"
    // (× sessions/mês); monthly = flat. Discount from the contract's loyalty %.
    const contractAddonKeys = c.addOns || [];
    const episodeServices = contractAddonKeys.map(k => allAddons.find(a => a.key === k)).filter((a): a is AddOnConfig => !!a && !a.monthly);
    const monthlyServices = contractAddonKeys.map(k => allAddons.find(a => a.key === k)).filter((a): a is AddOnConfig => !!a && !!a.monthly);
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

    const isAvulso = c.type === 'AVULSO' || (c.type === 'FLEX' && c.durationMonths === 1);
    const isFlex = c.type === 'FLEX' && !isAvulso;
    // Standalone monthly service (e.g. Gestão de Redes Sociais): no recordings — show the
    // service panel + payments instead of the episode progress/booking sections.
    const isServico = c.type === 'SERVICO';
    const serviceAddon = isServico ? (allAddons.find(a => a.key === (c.addOns || [])[0]) || null) : null;

    // FLEX weekly-window state (display-only; mirrors backend computeFlexState).
    // Safe default: if flexCycleStart is missing the engine returns started=false
    // and the counter is hidden, so we never break on incomplete data.
    const flexState = isFlex
        ? computeFlexState({
            total: c.flexCreditsTotal ?? 0,
            cycleStart: c.flexCycleStart ? new Date(c.flexCycleStart) : null,
            bookingDates: bookings.map(b => new Date(`${b.date.split('T')[0]}T${b.startTime || '00:00'}:00`)),
            now,
        })
        : null;
    const flexForfeited = c.flexCreditsForfeited ?? 0;
    const flexRemaining = c.flexCreditsRemaining ?? 0;
    const flexTotal = c.flexCreditsTotal ?? 0;
    const flexUsed = Math.max(0, flexTotal - flexRemaining - flexForfeited);

    const daysLeft = Math.ceil((new Date(c.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const isExpiring = c.status === 'ACTIVE' && !isAvulso && daysLeft >= 0 && daysLeft <= 15;

    const accentType = c.type === 'FIXO' ? 'fixo' : isAvulso ? 'avulso' : c.type === 'CUSTOM' ? 'custom' : c.type === 'SERVICO' ? 'servico' : 'flex';

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
                            ) : c.type === 'SERVICO' ? (
                                <span className="badge badge-audiencia">📅 Serviço Mensal</span>
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
                                    {new Date(isFlex && c.flexCycleStart ? c.flexCycleStart : c.startDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })} — {new Date(c.endDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    {' · '}{c.durationMonths} meses · Desconto <strong className="contract-card__discount">{c.discountPct}%</strong>
                                    {' · '}{c.paymentPlan === 'FULL' ? 'Quitado à vista' : 'Mensal'}
                                </>
                            )}
                        </div>
                        {c.type === 'FIXO' && (
                            <div className="contract-card__detail">
                                Dia fixo: <strong>{c.fixedDayOfWeek !== null && c.fixedDayOfWeek !== undefined ? DAY_NAMES[c.fixedDayOfWeek] : '—'}</strong>
                                {c.fixedTime && <> · Horário: <strong>{c.fixedTime}</strong></>}
                            </div>
                        )}
                        {isFlex && (
                            <div className="contract-card__detail">
                                Créditos: <strong>{flexRemaining}</strong> restantes de <strong>{flexTotal}</strong>
                            </div>
                        )}
                        {isFlex && flexState && c.status === 'ACTIVE' && !isArchived && (() => {
                            if (!flexState.started) {
                                return (
                                    <div
                                        className="flex-window flex-window--idle"
                                        aria-label="O ciclo do contrato FLEX começa na sua primeira gravação"
                                    >
                                        <CalendarClock size={14} className="flex-window__icon" aria-hidden="true" />
                                        <span>Ciclo começa na 1ª gravação</span>
                                    </div>
                                );
                            }
                            if (flexState.recordedThisWindow) {
                                return (
                                    <div
                                        className="flex-window flex-window--done"
                                        aria-label="Você já gravou nesta semana"
                                    >
                                        <CheckCircle2 size={14} className="flex-window__icon" aria-hidden="true" />
                                        <span>Gravação desta semana feita</span>
                                    </div>
                                );
                            }
                            if (flexState.daysLeftInWindow !== null) {
                                const d = flexState.daysLeftInWindow;
                                const urgent = d <= 2;
                                return (
                                    <div
                                        className={`flex-window ${urgent ? 'flex-window--urgent' : 'flex-window--pending'}`}
                                        role="status"
                                        aria-label={`Faltam ${d} dia${d === 1 ? '' : 's'} para gravar esta semana`}
                                    >
                                        <CalendarClock size={14} className="flex-window__icon" aria-hidden="true" />
                                        <span>{d} dia{d === 1 ? '' : 's'} para gravar esta semana</span>
                                    </div>
                                );
                            }
                            return null;
                        })()}
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

                {/* Consumption bar or Cancelled Stats — services have no episodes */}
                {isServico ? null : isCancelled ? (
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
                        {isFlex && (
                            <div className="flex-credits-breakdown">
                                <span>Usados <strong>{flexUsed}</strong></span>
                                <span className="flex-credits-breakdown__sep">·</span>
                                <span>Restantes <strong>{flexRemaining}</strong></span>
                                {flexForfeited > 0 && (
                                    <>
                                        <span className="flex-credits-breakdown__sep">·</span>
                                        <span className="flex-credits-breakdown__forfeited">
                                            Perdidos <strong>{flexForfeited}</strong>
                                        </span>
                                    </>
                                )}
                            </div>
                        )}

                        {/* FLEX recordings timeline — one pill per week, banking-aware */}
                        {isFlex && flexState && c.status === 'ACTIVE' && !isArchived && (() => {
                            if (!flexState.started) {
                                return (
                                    <div className="flex-timeline flex-timeline--idle">
                                        <CalendarClock size={13} className="flex-timeline__idle-icon" aria-hidden="true" />
                                        <span>A linha do tempo começa na sua 1ª gravação.</span>
                                    </div>
                                );
                            }
                            const statuses = flexWeekStatuses({
                                total: flexTotal,
                                cycleStart: c.flexCycleStart ? new Date(c.flexCycleStart) : null,
                                bookingDates: bookings.map(b => new Date(`${b.date.split('T')[0]}T${b.startTime || '00:00'}:00`)),
                                now,
                            });
                            if (statuses.length === 0) return null;
                            const labelFor = (s: typeof statuses[number]) =>
                                s === 'recorded' ? 'gravada'
                                : s === 'open' ? 'semana atual, em aberto'
                                : s === 'missed' ? 'crédito perdido'
                                : 'futura';
                            const glyphFor = (s: typeof statuses[number]) =>
                                s === 'recorded' ? '✓' : s === 'open' ? '⏳' : s === 'missed' ? '✕' : '○';
                            return (
                                <div className="flex-timeline">
                                    <div className="flex-timeline__pills" role="list" aria-label="Linha do tempo de gravações por semana">
                                        {statuses.map((s, i) => (
                                            <span
                                                key={i}
                                                role="listitem"
                                                className={`flex-pill flex-pill--${s}`}
                                                title={`Semana ${i + 1}: ${labelFor(s)}`}
                                                aria-label={`Semana ${i + 1}: ${labelFor(s)}`}
                                            >
                                                <span className="flex-pill__glyph" aria-hidden="true">{glyphFor(s)}</span>
                                                <span className="flex-pill__num">{i + 1}</span>
                                            </span>
                                        ))}
                                    </div>
                                    <div className="flex-timeline__legend" aria-hidden="true">
                                        <span className="flex-timeline__legend-item"><span className="flex-dot flex-dot--recorded" /> Gravada</span>
                                        <span className="flex-timeline__legend-item"><span className="flex-dot flex-dot--open" /> Esta semana</span>
                                        <span className="flex-timeline__legend-item"><span className="flex-dot flex-dot--missed" /> Perdida</span>
                                        <span className="flex-timeline__legend-item"><span className="flex-dot flex-dot--future" /> Futura</span>
                                    </div>
                                </div>
                            );
                        })()}

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

                    {isServico && (
                        <ServiceContractPanel contract={c} addon={serviceAddon} />
                    )}

                    {isFlex && (
                        <div className="contract-flex-rules">
                            <div className="contract-flex-rules__head">
                                <Info size={15} className="contract-flex-rules__icon" aria-hidden="true" />
                                <span className="contract-flex-rules__title">Como funciona o FLEX</span>
                            </div>
                            <p className="contract-flex-rules__text">
                                O contrato começa na sua 1ª gravação. Você ganha 1 crédito por semana —
                                grave pelo menos 1x por semana. Pode adiantar (gravar várias numa semana)
                                para cobrir semanas futuras. Se uma semana passar e você estiver atrás do
                                ritmo, 1 crédito é perdido.
                            </p>
                        </div>
                    )}

                    {/* Serviços do contrato — valor por gravação (ponto focal do cliente) */}
                    {!isServico && (episodeServices.length > 0 || monthlyServices.length > 0) && (
                        <div className="contract-booking-group">
                            <h4 className="contract-booking-group__title">
                                <Sparkles size={14} style={{ verticalAlign: '-2px', marginRight: 4 }} /> Serviços do contrato
                            </h4>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 10px' }}>
                                Acompanham toda gravação{(c.discountPct || 0) > 0 ? ` · ${c.discountPct}% de desconto aplicado` : ''}.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {episodeServices.map(s => (
                                    <ServiceLineItem key={s.key} name={s.name} description={s.description}
                                        perRecordingCents={Math.round(s.price * (1 - (c.discountPct || 0) / 100))}
                                        sessionsPerMonth={sessionsPerMonth} />
                                ))}
                                {monthlyServices.map(s => (
                                    <ServiceLineItem key={s.key} name={s.name} description={s.description} monthly
                                        perRecordingCents={0} perMonthCents={Math.round(s.price * (1 - (c.discountPct || 0) / 100))} />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Pending */}
                    {!isServico && !isCancelled && (
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
                    {!isServico && (
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
                    )}

                    {/* Parcelas & Pagamentos — visíveis no contrato (ponto focal do cliente) */}
                    {!isAvulso && c.payments && c.payments.length > 0 && (
                        <div className="contract-booking-group">
                            <h4 className="contract-booking-group__title">
                                Parcelas & Pagamentos <span className="badge badge-reserved">{c.payments.length}</span>
                            </h4>
                            <div>
                                {c.payments.map(p => {
                                    const meta = PAYMENT_LABEL[p.status] || { label: p.status, cls: 'badge-muted' };
                                    const payable = (p.status === 'PENDING' || p.status === 'FAILED') && !!onPayInstallment;
                                    return (
                                        <div key={p.id}
                                            className="contract-booking-item"
                                            style={{ cursor: payable ? 'pointer' : 'default' }}
                                            role={payable ? 'button' : undefined}
                                            tabIndex={payable ? 0 : undefined}
                                            onClick={payable ? () => onPayInstallment!(p) : undefined}
                                            aria-label={payable ? `Pagar parcela de ${formatBRL(p.amount)}` : undefined}
                                        >
                                            <div>
                                                <div className="contract-booking-item__date">{formatBRL(p.amount)}</div>
                                                <div className="contract-booking-item__time">
                                                    {p.status === 'PAID' && p.paidAt
                                                        ? `Pago em ${new Date(p.paidAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`
                                                        : `Vence ${p.dueDate ? new Date(p.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—'}`}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                {payable && <span className="contract-booking-item__manage">Pagar</span>}
                                                <span className={`badge ${meta.cls}`}>{meta.label}</span>
                                                {payable && <ChevronRight size={15} style={{ color: 'var(--accent-primary)' }} />}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {c.status === 'ACTIVE' && (
                        <div className="contract-actions">
                            {(isExpiring || isServico) && onRenewContract && (
                                <button className="btn btn-primary btn-sm contract-actions__renew"
                                    onClick={(e) => { e.stopPropagation(); onRenewContract(); }}>
                                    {isServico ? 'Renovar Serviço' : 'Renovar Contrato'}
                                </button>
                            )}
                            {!isAvulso && !isServico && c.status === 'ACTIVE' && onSubscribeContract && (
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
                                        onRequestCancel(c.id, isServico ? 'o encerramento do serviço e a interrupção das próximas cobranças.' : c.type === 'FIXO' ? '20% do valor correspondente aos meses/agendamentos que faltavam realizar.' : '20% do valor correspondente aos créditos não utilizados.');
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
