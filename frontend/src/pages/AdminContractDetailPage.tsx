import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { contractsApi, pricingApi, paymentsApi, bookingsApi, ContractDetail, PaymentSummary, AddOnConfig, Booking } from '../api/client';
import { useBusinessConfig } from '../hooks/useBusinessConfig';
import { useUI } from '../context/UIContext';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import StatusBadge from '../components/ui/StatusBadge';
import ServiceLineItem from '../components/ui/ServiceLineItem';
import ServiceContractPanel from '../components/client/ServiceContractPanel';
import BottomSheetModal from '../components/BottomSheetModal';
import InlineCheckout from '../components/InlineCheckout';
import FinalizeRecordingModal from '../components/admin/bookings/FinalizeRecordingModal';
import { TIER_META, BOOKING_STATUS_META, CONTRACT_STATUS_META, CONTRACT_TYPE_META, getMeta } from '../constants/adminMeta';
import { getPaymentBadge } from '../constants/paymentMethods';
import { decomposeBookingPricing, AddonCatalogEntry } from '../utils/bookingPricing';
import { formatBRL } from '../utils/format';
import { getErrorMessage } from '../utils/errors';
import { ArrowLeft, Mic, CreditCard, Receipt, Sparkles, ExternalLink, CheckCircle2, Zap } from 'lucide-react';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export default function AdminContractDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { showToast, showConfirm } = useUI();
    const { get: getRule } = useBusinessConfig();
    const sessionsPerMonth = getRule('sessions_per_month');

    const [contract, setContract] = useState<ContractDetail | null>(null);
    const [addons, setAddons] = useState<AddOnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [sandbox, setSandbox] = useState(false);
    const [charge, setCharge] = useState<PaymentSummary | null>(null);
    const [editingServices, setEditingServices] = useState(false);
    const [serviceDraft, setServiceDraft] = useState<string[]>([]);
    const [savingServices, setSavingServices] = useState(false);
    const [finalizeBooking, setFinalizeBooking] = useState<Booking | null>(null);

    const load = useCallback(async () => {
        if (!id) return;
        try {
            const [c, a] = await Promise.all([contractsApi.getById(id), pricingApi.getAddons()]);
            setContract(c.contract);
            setAddons(a.addons);
        } catch { setContract(null); }
        finally { setLoading(false); }
    }, [id]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { paymentsApi.getSandboxMode().then(s => setSandbox(s.pix || s.card)).catch(() => {}); }, []);

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={4} cols={3} /></div>;
    if (!contract) return (
        <div style={{ padding: 24 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/contracts')}><ArrowLeft size={14} /> Voltar</button>
            <div style={{ marginTop: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Contrato não encontrado.</div>
        </div>
    );

    // Add-on catalog for booking decomposition + contract services summary.
    const catalog: Record<string, AddonCatalogEntry> = Object.fromEntries(addons.map(a => [a.key, { name: a.name, price: a.price, monthly: a.monthly }]));
    const discountPct = contract.discountPct || 0;
    const priceIncludesServices = contract.type === 'AVULSO'; // contract bookings bill services monthly; avulso bundles them

    // Per-episode services on the contract (accompany every recording).
    const episodeServices = (contract.addOns || []).map(k => addons.find(a => a.key === k)).filter((a): a is AddOnConfig => !!a && !a.monthly);
    const monthlyServices = (contract.addOns || []).map(k => addons.find(a => a.key === k)).filter((a): a is AddOnConfig => !!a && !!a.monthly);

    // Payment-derived totals (most reliable single source).
    const payments = contract.payments || [];
    const contractValue = payments.reduce((s, p) => s + p.amount, 0);
    const paidValue = payments.filter(p => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
    const pendingValue = payments.filter(p => p.status === 'PENDING' || p.status === 'FAILED').reduce((s, p) => s + p.amount, 0);

    const bookings = contract.bookings || [];
    const completedCount = bookings.filter(b => b.status === 'COMPLETED').length;

    const cMeta = getMeta(CONTRACT_STATUS_META, contract.status);
    const tMeta = getMeta(CONTRACT_TYPE_META, contract.type);
    const tierMeta = getMeta(TIER_META, contract.tier);

    const markPaid = (p: PaymentSummary) => showConfirm({
        title: 'Marcar como pago',
        message: `Confirmar recebimento de ${formatBRL(p.amount)} manualmente? Use apenas se o pagamento foi recebido por fora do sistema.`,
        onConfirm: async () => { try { await paymentsApi.update(p.id, { status: 'PAID' }); showToast('Pagamento marcado como pago.'); load(); } catch { showToast('Erro ao atualizar.'); } },
    });

    const simulate = async (p: PaymentSummary) => { try { await paymentsApi.simulate(p.id); showToast('Pagamento simulado (sandbox).'); load(); } catch { showToast('Erro na simulação.'); } };


    // Editing recurring services is allowed only for FIXO/FLEX active contracts (recompute future).
    const canEditServices = contract.status === 'ACTIVE' && (contract.type === 'FIXO' || contract.type === 'FLEX');
    const episodeCatalog = addons.filter(a => !a.monthly);
    const startEditServices = () => { setServiceDraft(episodeServices.map(s => s.key)); setEditingServices(true); };
    const saveServices = async () => {
        setSavingServices(true);
        try {
            const monthlyKept = (contract.addOns || []).filter(k => addons.find(a => a.key === k)?.monthly);
            await contractsApi.update(contract.id, { addOns: [...monthlyKept, ...serviceDraft] });
            setEditingServices(false);
            showToast('Serviços atualizados. Parcelas pendentes e próximos episódios recalculados.');
            load();
        } catch (e) { showToast(getErrorMessage(e) || 'Erro ao atualizar serviços.'); }
        finally { setSavingServices(false); }
    };

    return (
        <div>
            <div style={{ marginBottom: 16 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/contracts')}><ArrowLeft size={14} /> Voltar para Contratos</button>
            </div>

            {/* ── Header ── */}
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ width: 52, height: 52, borderRadius: 14, flexShrink: 0, display: 'grid', placeItems: 'center', background: tierMeta.bg, color: tierMeta.color }}>
                        {(() => { const TI = tMeta.icon; return <TI size={24} />; })()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <h1 style={{ fontSize: '1.25rem', fontWeight: 800, margin: 0 }}>{contract.name}</h1>
                        {contract.user && (
                            <button onClick={() => navigate(`/admin/clients/${contract.user!.id}`)}
                                style={{ marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '0.8125rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                {contract.user.name} <ExternalLink size={12} />
                            </button>
                        )}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                            <StatusBadge meta={tMeta} />
                            <StatusBadge meta={tierMeta} label={contract.tier} />
                            <StatusBadge meta={cMeta} />
                            {contract.contractUrl && (
                                <a href={contract.contractUrl} target="_blank" rel="noopener noreferrer" className="status-badge status-badge--sm" style={{ color: 'var(--accent-primary)', background: 'var(--tier-audiencia-bg)', textDecoration: 'none' }}>
                                    <ExternalLink size={12} /> Contrato digital
                                </a>
                            )}
                        </div>
                    </div>
                </div>

                <div className="admin-grid-2" style={{ marginTop: 16, gap: 12 }}>
                    <Meta label="Vigência" value={`${fmtDate(contract.startDate)} – ${fmtDate(contract.endDate)}`} />
                    <Meta label="Duração / Desconto" value={`${contract.durationMonths} meses · ${discountPct}% fidelidade`} />
                    <Meta label="Plano de pagamento" value={contract.paymentPlan === 'FULL' ? 'Integral (à vista)' : 'Mensal (parcelado)'} />
                    <Meta label="Forma de pagamento" value={contract.paymentMethod ? `${getPaymentBadge(contract.paymentMethod).emoji} ${getPaymentBadge(contract.paymentMethod).label}` : '—'} />
                    {contract.type === 'FLEX' && contract.flexCreditsRemaining != null && (
                        <Meta label="Créditos restantes" value={`${contract.flexCreditsRemaining} de ${contract.flexCreditsTotal ?? '—'}`} />
                    )}
                </div>
            </div>

            {/* ── Totals strip ── */}
            <div className="admin-grid-3" style={{ gap: 12, marginBottom: 16 }}>
                <TotalCard label="Valor do contrato" value={contractValue} color="var(--text-primary)" />
                <TotalCard label="Pago" value={paidValue} color="var(--success)" />
                <TotalCard label="Pendente" value={pendingValue} color={pendingValue > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
            </div>

            {/* ── Contract services (editable for FIXO/FLEX active) ── */}
            {(canEditServices || episodeServices.length > 0 || monthlyServices.length > 0) && (
                <div className="admin-card" style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <SectionTitle icon={<Sparkles size={16} />} title="Serviços do contrato" />
                        {canEditServices && !editingServices && (
                            <button className="btn btn-ghost btn-sm" onClick={startEditServices} style={{ marginBottom: 14 }}>
                                Editar serviços
                            </button>
                        )}
                    </div>

                    {editingServices ? (
                        <>
                            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 12px' }}>
                                Afeta as <strong>parcelas pendentes</strong> e os <strong>próximos episódios</strong>; não altera o que já foi pago/realizado.
                            </p>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {episodeCatalog.map(a => {
                                    const selected = serviceDraft.includes(a.key);
                                    return (
                                        <ServiceLineItem key={a.key} name={a.name} description={a.description}
                                            perRecordingCents={Math.round(a.price * (1 - discountPct / 100))} sessionsPerMonth={sessionsPerMonth}
                                            selected={selected}
                                            onToggle={() => setServiceDraft(prev => selected ? prev.filter(k => k !== a.key) : [...prev, a.key])} />
                                    );
                                })}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                                <button className="btn btn-ghost btn-sm" onClick={() => setEditingServices(false)} disabled={savingServices}>Cancelar</button>
                                <button className="btn btn-primary btn-sm" onClick={saveServices} disabled={savingServices}>
                                    {savingServices ? 'Salvando…' : 'Salvar serviços'}
                                </button>
                            </div>
                        </>
                    ) : (episodeServices.length > 0 || monthlyServices.length > 0) ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {episodeServices.map(s => (
                                <ServiceLineItem key={s.key} name={s.name} description={s.description}
                                    perRecordingCents={Math.round(s.price * (1 - discountPct / 100))} sessionsPerMonth={sessionsPerMonth} />
                            ))}
                            {monthlyServices.map(s => (
                                <ServiceLineItem key={s.key} name={s.name} description={s.description} monthly
                                    perRecordingCents={0} perMonthCents={Math.round(s.price * (1 - discountPct / 100))} />
                            ))}
                        </div>
                    ) : (
                        <Empty>Nenhum serviço recorrente. Use "Editar serviços" para incluir.</Empty>
                    )}
                </div>
            )}

            {/* ── Recordings (standalone monthly services have none) ── */}
            {contract.type === 'SERVICO' ? (
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <ServiceContractPanel contract={contract} addon={addons.find(a => a.key === (contract.addOns || [])[0]) || null} />
            </div>
            ) : (
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <SectionTitle icon={<Mic size={16} />} title={`Gravações (${completedCount}/${bookings.length})`} />
                {bookings.length === 0 ? (
                    <Empty>Nenhuma gravação ainda.</Empty>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {bookings.map(b => {
                            const dec = decomposeBookingPricing({ priceCents: b.price, addOns: b.addOns, addonCatalog: catalog, discountPct, priceIncludesServices });
                            const bMeta = getMeta(BOOKING_STATUS_META, b.status);
                            const canFinalize = b.status === 'CONFIRMED' || b.status === 'RESERVED';
                            const canEditData = b.status === 'COMPLETED';
                            return (
                                <div key={b.id} style={{ padding: 'var(--space-3)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>
                                            {new Date(b.date).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' })}
                                        </div>
                                        <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{b.startTime}–{b.endTime}</div>
                                        <StatusBadge meta={bMeta} />
                                        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                                            <div style={{ fontWeight: 800, fontSize: '0.9375rem' }}>{formatBRL(dec.totalCents)}</div>
                                            {dec.servicesCents > 0 && (
                                                <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                                    {formatBRL(dec.baseCents)} base + {formatBRL(dec.servicesCents)} serviços
                                                    {!priceIncludesServices && <span> · cobrados na mensalidade</span>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {dec.perService.length > 0 && (
                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                                            {dec.perService.map(s => (
                                                <span key={s.key} style={{ fontSize: '0.6875rem', fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--tier-audiencia-bg)', color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                                    <Sparkles size={11} /> {s.name} · {formatBRL(s.unitCents)}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    {(b.status === 'COMPLETED' && (b.peakViewers != null || b.durationMinutes != null)) && (
                                        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                            {b.durationMinutes != null && <span>⏱️ {b.durationMinutes} min</span>}
                                            {b.peakViewers != null && <span>👁️ {b.peakViewers} pico</span>}
                                            {b.chatMessages != null && <span>💬 {b.chatMessages}</span>}
                                        </div>
                                    )}
                                    {(canFinalize || canEditData) && (
                                        <div style={{ marginTop: 8 }}>
                                            <button className="btn btn-ghost btn-sm" onClick={() => setFinalizeBooking(b)}>
                                                <CheckCircle2 size={14} /> {canEditData ? 'Editar dados da gravação' : 'Finalizar gravação'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
            )}

            {/* ── Payments / installments ── */}
            <div className="admin-card" style={{ marginBottom: 16 }}>
                <SectionTitle icon={<Receipt size={16} />} title={`Pagamentos & Parcelas (${payments.length})`} />
                {payments.length === 0 ? (
                    <Empty>Nenhuma cobrança gerada.</Empty>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {payments.map((p, i) => {
                            const pMeta = getMeta(BOOKING_STATUS_META, p.status);
                            const isOpen = p.status === 'PENDING' || p.status === 'FAILED';
                            return (
                                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 'var(--space-3)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)' }}>
                                    <div style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--bg-elevated)', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)' }}>{i + 1}</div>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>{formatBRL(p.amount)}</div>
                                        <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                                            Vence {p.dueDate ? fmtDate(p.dueDate) : '—'}{p.provider ? ` · ${getPaymentBadge(p.provider === 'STRIPE' ? 'CARTAO' : p.provider === 'CORA' ? 'PIX' : p.provider).label}` : ''}
                                        </div>
                                    </div>
                                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                        <StatusBadge meta={pMeta} />
                                        {isOpen && (
                                            <>
                                                <button className="btn btn-sm" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, padding: '5px 12px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={() => setCharge(p)}>
                                                    <CreditCard size={13} /> Cobrar
                                                </button>
                                                {sandbox && (
                                                    <button className="btn btn-ghost btn-sm" title="Simular pagamento (sandbox)" onClick={() => simulate(p)}><Zap size={13} /></button>
                                                )}
                                                <button className="btn btn-ghost btn-sm" onClick={() => markPaid(p)}>Marcar pago</button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Charge-now modal (reuses the client InlineCheckout, role-aware) ── */}
            {charge && (
                <BottomSheetModal isOpen onClose={() => setCharge(null)} hideHeader size="sm" className="admin-sheet" title="Cobrar parcela">
                    <div style={{ padding: '24px 28px' }}>
                        <h3 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px' }}>Cobrar {formatBRL(charge.amount)}</h3>
                        <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                            Gera PIX ou cobra o cartão do cliente (presente). A cobrança é feita em nome do cliente.
                        </p>
                        <InlineCheckout
                            amount={charge.amount}
                            paymentId={charge.id}
                            description={`${contract.name} - parcela`}
                            allowedMethods={(contract.boletoAllowed ? ['CARTAO', 'PIX', 'BOLETO'] : ['CARTAO', 'PIX']) as ('CARTAO' | 'PIX' | 'BOLETO')[]}
                            isAdmin
                            allowBoleto={!!contract.boletoAllowed}
                            context="contract"
                            onSuccess={() => { setCharge(null); showToast('Pagamento confirmado!'); load(); }}
                            onError={(msg) => showToast(msg)}
                            onCancel={() => setCharge(null)}
                        />
                    </div>
                </BottomSheetModal>
            )}

            <FinalizeRecordingModal
                isOpen={!!finalizeBooking}
                booking={finalizeBooking}
                onClose={() => setFinalizeBooking(null)}
                onSaved={() => { setFinalizeBooking(null); load(); }}
            />
        </div>
    );
}

// ── Small presentational helpers ──
function Meta({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>{value}</div>
        </div>
    );
}

function TotalCard({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div className="admin-card" style={{ padding: 'var(--space-4)' }}>
            <div style={{ fontSize: '0.625rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 800, color }}>{formatBRL(value)}</div>
        </div>
    );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: 'var(--text-primary)' }}>
            <span style={{ color: 'var(--accent-primary)', display: 'flex' }}>{icon}</span>
            <h2 style={{ fontSize: '0.9375rem', fontWeight: 700, margin: 0 }}>{title}</h2>
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>{children}</div>;
}
