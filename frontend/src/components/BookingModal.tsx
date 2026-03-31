import React, { useState, useEffect } from 'react';
import ModalOverlay from './ModalOverlay';
import { bookingsApi, contractsApi, pricingApi, ContractWithStats } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { getPaymentMethods, PaymentMethodKey } from '../constants/paymentMethods';

interface BookingModalProps {
    date: string;
    time: string;
    tier: string;
    price: number;
    onClose: () => void;
    onBooked: () => void;
    onNewContract?: (date: string, time: string) => void;
}

function formatBRL(cents: number): string {
    return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

const TIER_LABELS: Record<string, string> = {
    COMERCIAL: '🏢 Comercial',
    AUDIENCIA: '🎤 Audiência',
    SABADO: '🌟 Sábado Premium',
};

type Step = 'choose' | 'avulso_pay' | 'processing' | 'done' | 'error';

export default function BookingModal({ date, time, tier, price, onClose, onBooked, onNewContract }: BookingModalProps) {
    const { user } = useAuth();
    const [step, setStep] = useState<Step>('choose');
    const [contracts, setContracts] = useState<ContractWithStats[]>([]);
    const [loadingContracts, setLoadingContracts] = useState(true);
    const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
    const [avulsoPayment, setAvulsoPayment] = useState<PaymentMethodKey | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    
    // Addons State
    interface Addon { key: string; name: string; price: number; description?: string | null; }
    const [availableAddons, setAvailableAddons] = useState<Addon[]>([]);
    const [selectedAddons, setSelectedAddons] = useState<string[]>([]);

    const endHour = parseInt(time.split(':')[0]) + 2;
    const endTime = `${endHour.toString().padStart(2, '0')}:${time.split(':')[1]}`;
    const dateDisplay = date.split('-').reverse().join('/');
    const tierUp = tier.toUpperCase();

    // Load client contracts on mount
    useEffect(() => {
        setLoadingContracts(true);
        Promise.all([
            contractsApi.getMy(),
            pricingApi.getAddons()
        ]).then(([contractsRes, addonsRes]) => {
            setContracts(contractsRes.contracts.filter((c: any) => c.status === 'ACTIVE'));
            setAvailableAddons(addonsRes.addons.filter((a: any) => a.key !== 'GESTAO_SOCIAL'));
        }).catch(err => console.error('Failed to load modal data:', err))
          .finally(() => setLoadingContracts(false));
    }, []);

    // Check if a contract is compatible with the selected slot
    const isCompatible = (c: ContractWithStats): boolean => {
        if (c.status !== 'ACTIVE') return false;
        
        // Custom contracts normally are scheduled upfront. They only allow ad-hoc booking if they have custom credits refunded.
        if (c.type === 'CUSTOM' && (c.customCreditsRemaining || 0) <= 0) {
            return false; 
        }

        const cTier = c.tier.toUpperCase();
        const slotTier = tierUp;

        // Tier hierarchy: SABADO can book all, AUDIENCIA can book COMERCIAL+AUDIENCIA, COMERCIAL only COMERCIAL
        if (cTier === 'SABADO') return true;
        if (cTier === 'AUDIENCIA') return slotTier === 'COMERCIAL' || slotTier === 'AUDIENCIA';
        if (cTier === 'COMERCIAL') return slotTier === 'COMERCIAL';
        return cTier === slotTier;
    };

    const hasCredits = (c: ContractWithStats): boolean => {
        if (c.type === 'CUSTOM') return (c.customCreditsRemaining || 0) > 0;
        return c.completedBookings < c.totalBookings;
    };

    const compatibleContracts = contracts.filter(c => isCompatible(c) && hasCredits(c));
    const incompatibleContracts = contracts.filter(c => !isCompatible(c) || !hasCredits(c));
    const hasCompatible = compatibleContracts.length > 0;

    // Compute extra cost
    const selectedContract = contracts.find(c => c.id === selectedContractId);
    const discountPct = selectedContract ? selectedContract.discountPct : 0;
    
    const addonsRawCost = selectedAddons.reduce((acc, key) => {
        const ad = availableAddons.find(a => a.key === key);
        return acc + (ad ? ad.price : 0);
    }, 0);
    const addonsCost = addonsRawCost * (1 - (discountPct / 100));

    // Handle booking with a contract (use plan)
    const handleUsePlan = async () => {
        setLoading(true);
        setError('');
        setStep('processing');
        try {
            await bookingsApi.create({ date, startTime: time, contractId: selectedContractId!, addOns: selectedAddons });
            setStep('done');
        } catch (err: any) {
            setError(err.message || 'Erro ao agendar');
            setStep('error');
        } finally {
            setLoading(false);
        }
    };

    // Handle avulso booking
    const handleAvulso = async () => {
        setLoading(true);
        setError('');
        setStep('processing');
        try {
            await bookingsApi.create({ date, startTime: time, addOns: selectedAddons });
            setStep('done');
        } catch (err: any) {
            setError(err.message || 'Erro ao agendar');
            setStep('error');
        } finally {
            setLoading(false);
        }
    };

    const handleNewContract = () => {
        onClose();
        if (onNewContract) {
            onNewContract(date, time);
        }
    };

    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal" style={{ maxWidth: 560 }}>

                {/* Step 1: Choose action */}
                {step === 'choose' && (
                    <>
                        {/* Header */}
                        <div style={{
                            textAlign: 'center', padding: '20px 0 16px',
                            borderBottom: '1px solid var(--border-subtle)', marginBottom: '20px'
                        }}>
                            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                Novo Agendamento
                            </div>
                            <div style={{ fontSize: '1.25rem', fontWeight: 800 }}>
                                📅 {dateDisplay} às {time}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '8px' }}>
                                <span className={`badge badge-${tier.toLowerCase()}`}>{TIER_LABELS[tierUp] || tier}</span>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>· {time} — {endTime}</span>
                            </div>
                        </div>

                        {/* Contract Analysis */}
                        {loadingContracts ? (
                            <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
                                ⏳ Verificando seus contratos...
                            </div>
                        ) : contracts.length > 0 ? (
                            <div style={{ marginBottom: '20px' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                                    Seus Contratos Ativos
                                </div>

                                {/* Compatible contracts */}
                                {compatibleContracts.map(c => (
                                    <div key={c.id}
                                        onClick={() => setSelectedContractId(selectedContractId === c.id ? null : c.id)}
                                        style={{
                                            padding: '14px 16px', borderRadius: 'var(--radius-md)', marginBottom: '8px', cursor: 'pointer',
                                            background: selectedContractId === c.id ? 'rgba(34, 197, 94, 0.1)' : 'rgba(34, 197, 94, 0.04)',
                                            border: `2px solid ${selectedContractId === c.id ? '#22c55e' : 'rgba(34, 197, 94, 0.2)'}`,
                                            transition: 'all 0.2s ease',
                                        }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: '#22c55e' }}>
                                                    ✅ {c.type === 'CUSTOM' ? '🎨 Personalizado' : c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'} — {c.tier} ({c.durationMonths}m)
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                                    {c.type === 'CUSTOM'
                                                        ? `Saldo: ${c.customCreditsRemaining} reagendamento(s) livre(s) de cancelamentos`
                                                        : `Saldo: ${c.totalBookings - c.completedBookings} gravações disponíveis de ${c.totalBookings}`
                                                    }
                                                </div>
                                            </div>
                                            <div style={{
                                                width: 22, height: 22, borderRadius: '50%',
                                                border: `2px solid ${selectedContractId === c.id ? '#22c55e' : 'var(--border-default)'}`,
                                                background: selectedContractId === c.id ? '#22c55e' : 'transparent',
                                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                transition: 'all 0.2s',
                                            }}>
                                                {selectedContractId === c.id && <span style={{ color: '#fff', fontSize: '0.75rem', fontWeight: 800 }}>✓</span>}
                                            </div>
                                        </div>
                                    </div>
                                ))}

                                {/* Incompatible contracts */}
                                {incompatibleContracts.map(c => (
                                    <div key={c.id} style={{
                                        padding: '14px 16px', borderRadius: 'var(--radius-md)', marginBottom: '8px',
                                        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
                                        opacity: 0.5, cursor: 'not-allowed',
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                                    {c.type === 'CUSTOM' ? '🎨 Personalizado' : c.type === 'FIXO' ? '📌 Fixo' : '🔄 Flex'} — {c.tier} ({c.durationMonths}m)
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                                    {!hasCredits(c)
                                                        ? (c.type === 'CUSTOM' ? 'ℹ️ Todas as sessões deste plano já estão agendadas na grade' : '⚠️ Sem créditos restantes')
                                                        : `⚠️ Incompatível com o horário selecionado (${TIER_LABELS[tierUp] || tier})`
                                                    }
                                                </div>
                                            </div>
                                            <span style={{ fontSize: '1rem' }}>🚫</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{
                                padding: '16px', borderRadius: 'var(--radius-md)',
                                background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)',
                                fontSize: '0.8125rem', color: 'var(--tier-audiencia)',
                                marginBottom: '20px', textAlign: 'center',
                            }}>
                                ℹ️ Você não possui contratos ativos. Agende como avulso ou crie um novo contrato!
                            </div>
                        )}

                        {/* Serviços Adicionais (Episódicos) */}
                        {availableAddons.length > 0 && (
                            <div style={{ marginBottom: '24px' }}>
                                <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                                    Incluir Extras (Neste Episódio)
                                    {discountPct > 0 && <span style={{ color: 'var(--accent-primary)', marginLeft: '8px' }}>— {discountPct}% OFF Aplicado pelo seu plano</span>}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '8px' }}>
                                    {availableAddons.map(addon => {
                                        const isSelected = selectedAddons.includes(addon.key);
                                        const adPriceDiscounted = addon.price * (1 - (discountPct / 100));
                                        
                                        return (
                                            <div aria-label="Formulário de agendamento" key={addon.key} 
                                                onClick={() => {
                                                    if (isSelected) setSelectedAddons(prev => prev.filter(k => k !== addon.key));
                                                    else setSelectedAddons(prev => [...prev, addon.key]);
                                                }}
                                                style={{
                                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                    padding: '12px 16px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                                    background: isSelected ? 'rgba(139, 92, 246, 0.1)' : 'var(--bg-secondary)',
                                                    border: `1px solid ${isSelected ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                    transition: 'all 0.2s ease',
                                                }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                                    <input type="checkbox" checked={isSelected} readOnly style={{ accentColor: 'var(--accent-primary)', width: '18px', height: '18px', cursor: 'pointer' }} />
                                                    <div>
                                                        <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{addon.name}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>+ {formatBRL(adPriceDiscounted)}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Separator */}
                        <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '16px' }}>
                            <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '12px' }}>
                                O que deseja fazer?
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                {/* CTA 1: Use Active Plan */}
                                <button
                                    className="btn btn-primary"
                                    onClick={handleUsePlan}
                                    disabled={!hasCompatible || !selectedContractId}
                                    style={{
                                        width: '100%', padding: '14px 20px', fontSize: '0.9375rem',
                                        opacity: hasCompatible ? 1 : 0.4,
                                        display: 'flex', justifyContent: 'center', gap: '10px'
                                    }}>
                                    {hasCompatible
                                        ? (selectedContractId ? `✅ Usar Plano Ativo ${addonsCost > 0 ? `| Pagar ${formatBRL(addonsCost)} extras` : ''}` : '☝️ Selecione um contrato acima')
                                        : '🔒 Usar Plano Ativo (sem contrato compatível)'}
                                </button>

                                {/* CTA 2: Book as Avulso */}
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => setStep('avulso_pay')}
                                    style={{ width: '100%', padding: '12px 20px', fontSize: '0.875rem' }}>
                                    💳 Contratar Avulso — {formatBRL(price + addonsCost)}
                                </button>

                                {/* CTA 3: Create New Contract */}
                                <button
                                    className="btn btn-ghost"
                                    onClick={handleNewContract}
                                    style={{
                                        width: '100%', padding: '12px 20px', fontSize: '0.875rem',
                                        border: '1px dashed var(--accent-primary)', color: 'var(--accent-primary)',
                                        background: !hasCompatible ? 'rgba(139, 92, 246, 0.06)' : 'transparent',
                                    }}>
                                    ✨ Criar Novo Contrato
                                    <span style={{ fontSize: '0.6875rem', display: 'block', marginTop: '2px', opacity: 0.8 }}>
                                        Economize até 40% em relação ao avulso
                                    </span>
                                </button>
                            </div>
                        </div>

                        <div className="modal-actions" style={{ marginTop: '16px' }}>
                            <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
                        </div>
                    </>
                )}

                {/* Step: Avulso Payment Options */}
                {step === 'avulso_pay' && (
                    <>
                        <h2 className="modal-title">💳 Agendamento Avulso</h2>
                        <div style={{
                            padding: '14px 16px', borderRadius: 'var(--radius-md)',
                            background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)',
                            fontSize: '0.8125rem', color: 'var(--tier-audiencia)',
                            marginBottom: '16px',
                        }}>
                            ⚠️ Este agendamento <strong>não está coberto</strong> por nenhum plano ativo.
                            O valor integral será cobrado.
                        </div>

                        <div style={{
                            display: 'flex', justifyContent: 'space-between',
                            padding: '14px 16px', background: 'var(--bg-secondary)',
                            borderRadius: 'var(--radius-md)', marginBottom: '16px'
                        }}>
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                                📅 {dateDisplay} · {time} — {endTime} {selectedAddons.length > 0 && `(+${selectedAddons.length} extras)`}
                            </span>
                            <span style={{ fontWeight: 800, fontSize: '1.125rem', color: 'var(--accent-primary)' }}>
                                {formatBRL(price + addonsCost)}
                            </span>
                        </div>

                        <div style={{ fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '10px' }}>
                            Forma de Pagamento
                        </div>

                        {/* Payment Method Cards */}
                        {getPaymentMethods().map(pm => {
                            const isSelected = avulsoPayment === pm.key;
                            return (
                                <div key={pm.key} onClick={() => setAvulsoPayment(pm.key as 'CARTAO' | 'PIX' | 'BOLETO')}
                                    style={{
                                        padding: '12px 14px', borderRadius: 'var(--radius-sm)', marginBottom: '10px', cursor: 'pointer',
                                        background: isSelected ? pm.bgActive : pm.bgInactive,
                                        border: `2px solid ${isSelected ? pm.borderActive : pm.borderInactive}`,
                                        transition: 'all 0.2s ease',
                                    }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{pm.emoji} {pm.label}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{pm.description}</div>
                                        </div>
                                        <div style={{ fontWeight: 800, fontSize: '1rem', color: pm.color }}>{formatBRL(price + addonsCost)}</div>
                                    </div>
                                </div>
                            );
                        })}

                        <div className="modal-actions">
                            <button className="btn btn-secondary" onClick={() => { setStep('choose'); setAvulsoPayment(null); }}>⬅ Voltar</button>
                            <button className="btn btn-primary" onClick={handleAvulso} disabled={!avulsoPayment || loading}>
                                {loading ? '⏳ Processando...' : '🔒 Confirmar Agendamento'}
                            </button>
                        </div>
                    </>
                )}

                {/* Processing */}
                {step === 'processing' && (
                    <div style={{ textAlign: 'center', padding: '40px 0' }}>
                        <div className="spinner" style={{ margin: '0 auto 16px' }}></div>
                        <p style={{ color: 'var(--text-secondary)' }}>Processando seu agendamento...</p>
                    </div>
                )}

                {/* Done */}
                {step === 'done' && (
                    <>
                        <div style={{ textAlign: 'center', padding: '20px 0' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '12px' }}>🎉</div>
                            <h2 className="modal-title" style={{ textAlign: 'center' }}>Agendamento Confirmado!</h2>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                                {dateDisplay} das {time} às {endTime}
                            </p>
                        </div>
                        <div className="modal-actions" style={{ justifyContent: 'center' }}>
                            <button className="btn btn-primary" onClick={onBooked}>Fechar</button>
                        </div>
                    </>
                )}

                {/* Error */}
                {step === 'error' && (
                    <>
                        <div style={{ textAlign: 'center', padding: '20px 0' }}>
                            <div style={{ fontSize: '3rem', marginBottom: '12px' }}>😞</div>
                            <h2 className="modal-title" style={{ textAlign: 'center' }}>Ops!</h2>
                            <div className="error-message">{error}</div>
                        </div>
                        <div className="modal-actions" style={{ justifyContent: 'center' }}>
                            <button className="btn btn-secondary" onClick={() => setStep('choose')}>Tentar Novamente</button>
                            <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
                        </div>
                    </>
                )}
            </div>
        </ModalOverlay>
    );
}
