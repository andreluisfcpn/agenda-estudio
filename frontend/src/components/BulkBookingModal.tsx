import React, { useState, useEffect } from 'react';
import ModalOverlay from './ModalOverlay';
import { bookingsApi, Slot } from '../api/client';

const DAY_NAMES_FULL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export interface BulkBookingModalProps {
    contract: {
        id: string;
        tier: string;
        type: string;
        flexCreditsRemaining: number;
        endDate: string;
    };
    onClose: () => void;
    onComplete: () => void;
}

export default function BulkBookingModal({ contract, onClose, onComplete }: BulkBookingModalProps) {
    const [currentDate, setCurrentDate] = useState('');
    const [availableSlots, setAvailableSlots] = useState<Slot[]>([]);
    const [loadingSlots, setLoadingSlots] = useState(false);

    // State for multiple selections
    const [selectedSlots, setSelectedSlots] = useState<{ date: string; startTime: string }[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    // Step system: 1 = Selection Grid, 2 = Confirmation Summary
    const [step, setStep] = useState<1 | 2>(1);

    const creditsToSpend = contract.flexCreditsRemaining;
    const remaining = creditsToSpend - selectedSlots.length;
    const usedPct = creditsToSpend > 0 ? ((selectedSlots.length) / creditsToSpend) * 100 : 0;

    // Generate upcoming dates up to contract End Date (max roughly 60 days ahead to avoid huge lists)
    const now = new Date();
    const allowedDates = Array.from({ length: 60 }, (_, i) => {
        const d = new Date(now);
        d.setDate(d.getDate() + i + 1); // tomorrow onwards
        return d;
    }).filter(d => {
        // Must be before contract ends
        const contractEnd = new Date(contract.endDate);
        if (d > contractEnd) return false;

        // Exclude Sundays
        if (d.getDay() === 0) return false;

        // For COMERCIAL: also exclude Saturdays
        if (contract.tier === 'COMERCIAL') return d.getDay() >= 1 && d.getDay() <= 5;

        return true;
    });

    useEffect(() => {
        if (currentDate && step === 1) {
            setLoadingSlots(true);
            bookingsApi.getAvailability(currentDate)
                .then(res => {
                    setAvailableSlots(res.slots);
                })
                .catch(err => {
                    console.error(err);
                    setError('Erro ao carregar horários disponíveis.');
                })
                .finally(() => setLoadingSlots(false));
        }
    }, [currentDate, step, contract.tier]);

    const toggleSlot = (time: string) => {
        const index = selectedSlots.findIndex(s => s.date === currentDate && s.startTime === time);
        if (index > -1) {
            // Remove
            setSelectedSlots(prev => prev.filter((_, i) => i !== index));
        } else {
            // Add if capacity allows
            if (remaining > 0) {
                setSelectedSlots(prev => [...prev, { date: currentDate, startTime: time }]);
            } else {
                setError('Você já selecionou o máximo de horários permitidos.');
                setTimeout(() => setError(''), 3000);
            }
        }
    };

    const isSelected = (time: string) => {
        return selectedSlots.some(s => s.date === currentDate && s.startTime === time);
    };

    const handleConfirm = async () => {
        if (selectedSlots.length === 0) return;
        setSubmitting(true);
        setError('');

        try {
            await bookingsApi.createBulk({
                contractId: contract.id,
                slots: selectedSlots,
            });
            onComplete();
        } catch (err: any) {
            setError(err.message || 'Erro ao salvar os agendamentos.');
            // Send back to review step to let them see error
            setStep(1);
            setSubmitting(false);
        }
    };

    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal" style={{ maxWidth: 640 }}>
                {/* Header always visible */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h2 className="modal-title" style={{ margin: 0 }}>Agendamento em Lote</h2>
                    <span className={`badge badge-${contract.tier.toLowerCase()}`}>
                        Plano {contract.tier}
                    </span>
                </div>

                <div style={{ background: 'var(--bg-secondary)', padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '24px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Créditos a alocar</span>
                        <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: remaining === 0 ? 'var(--status-available)' : 'var(--text-primary)' }}>
                            {remaining === 0 ? 'Tudo alocado!' : `Faltam ${remaining} marcações`}
                        </span>
                    </div>
                    <div style={{ height: 8, borderRadius: 4, background: 'var(--bg-card)', overflow: 'hidden' }}>
                        <div style={{
                            height: '100%', borderRadius: 4,
                            background: usedPct >= 100 ? 'var(--status-available)' : 'var(--accent-primary)',
                            width: `${Math.min(usedPct, 100)}%`, transition: 'width 0.3s ease, background 0.3s ease',
                        }} />
                    </div>
                </div>

                {error && (
                    <div style={{ padding: '12px 16px', borderRadius: 'var(--radius-md)', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', fontSize: '0.875rem', marginBottom: '16px' }}>
                        ❌ {error}
                    </div>
                )}

                {/* ══════════ STEP 1: SELECTION ══════════ */}
                {step === 1 && (
                    <>
                        <div className="form-group" style={{ marginBottom: '16px' }}>
                            <label className="form-label">Escolha um Dia</label>
                            <select className="form-input" value={currentDate} onChange={e => setCurrentDate(e.target.value)}>
                                <option value="">-- Selecione a Data --</option>
                                {allowedDates.map(d => {
                                    const y = d.getFullYear();
                                    const m = String(d.getMonth() + 1).padStart(2, '0');
                                    const day = String(d.getDate()).padStart(2, '0');
                                    const dateStr = `${y}-${m}-${day}`;

                                    // Count how many selected on this day
                                    const countForDay = selectedSlots.filter(s => s.date === dateStr).length;

                                    return (
                                        <option key={dateStr} value={dateStr}>
                                            {DAY_NAMES_FULL[d.getDay()]}, {day}/{m}/{y} {countForDay > 0 ? `(${countForDay} marcados)` : ''}
                                        </option>
                                    );
                                })}
                            </select>
                        </div>

                        {currentDate && (
                            <div className="form-group" style={{ marginBottom: '24px' }}>
                                <label className="form-label">Faixa de Horário (Duração 2h)</label>
                                {loadingSlots ? (
                                    <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '20px', textAlign: 'center', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
                                        <div className="spinner" style={{ margin: '0 auto 12px' }} />
                                        Mapeando estúdios...
                                    </div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                        {availableSlots.map(s => {
                                            const isTierAllowed = contract.tier === 'COMERCIAL' ? s.time <= '15:30' : true;

                                            // Time check
                                            const slotDateTime = new Date(`${currentDate}T${s.time}:00`);
                                            const isPast = (slotDateTime.getTime() - Date.now()) / (1000 * 60) < 30;

                                            const active = isSelected(s.time);
                                            const allowed = (s.available && isTierAllowed && !isPast) || active;

                                            const [h] = s.time.split(':').map(Number);
                                            const endTime = `${h + 2}:${s.time.split(':')[1]}`;

                                            return (
                                                <div key={s.time}
                                                    onClick={() => allowed && toggleSlot(s.time)}
                                                    style={{
                                                        padding: '16px', borderRadius: 'var(--radius-md)',
                                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                                        cursor: allowed ? (remaining > 0 || active ? 'pointer' : 'not-allowed') : 'not-allowed',
                                                        border: `2px solid ${active ? '#22c55e' : (allowed ? 'var(--border-subtle)' : 'transparent')}`,
                                                        background: active ? 'rgba(34, 197, 94, 0.1)' : (allowed ? 'var(--bg-card)' : 'var(--bg-secondary)'),
                                                        opacity: allowed ? 1 : 0.6,
                                                        transition: 'all 0.2s',
                                                    }}>
                                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                        <span style={{ fontWeight: 800, fontSize: '1rem', color: active ? '#22c55e' : 'var(--text-primary)' }}>
                                                            {s.time} - {endTime}
                                                        </span>
                                                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                                                            {s.tier === 'COMERCIAL' ? '🏢 Comercial' : (s.tier === 'AUDIENCIA' ? '🎤 Audiência' : '🌟 Sábado')}
                                                        </span>
                                                    </div>
                                                    <div>
                                                        {!isTierAllowed ? (
                                                            <span style={{ fontSize: '0.875rem' }} title={`Exclusivo para planos ${s.tier}`}>🔒</span>
                                                        ) : (!s.available && !active) ? (
                                                            <span style={{ fontSize: '0.8125rem', color: 'var(--status-blocked)', fontWeight: 600 }}>Ocupado</span>
                                                        ) : active ? (
                                                            <span style={{ color: '#22c55e', fontWeight: 800 }}>✓ Marcado</span>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        {availableSlots.length === 0 && (
                                            <div style={{ gridColumn: '1 / -1', fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '16px', textAlign: 'center', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)' }}>
                                                Não há agendas livres para o estúdio {contract.tier} nesta data.
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="modal-actions" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border-subtle)', paddingTop: '20px' }}>
                            <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
                            <button className="btn btn-primary"
                                onClick={() => setStep(2)}
                                disabled={selectedSlots.length === 0}>
                                Revisar Agendamentos ({selectedSlots.length}) ➔
                            </button>
                        </div>
                    </>
                )}

                {/* ══════════ STEP 2: SUMMARY ══════════ */}
                {step === 2 && (
                    <>
                        <h3 style={{ fontSize: '1rem', marginBottom: '16px' }}>Resumo dos Agendamentos</h3>

                        <div style={{ maxHeight: 300, overflowY: 'auto', marginBottom: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            {selectedSlots.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).map((s, idx) => {
                                const d = new Date(`${s.date}T12:00:00`);
                                const y = d.getFullYear();
                                const m = String(d.getMonth() + 1).padStart(2, '0');
                                const day = String(d.getDate()).padStart(2, '0');

                                return (
                                    <div key={idx} style={{ padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--border-subtle)' }}>
                                        <div>
                                            <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{DAY_NAMES_FULL[d.getDay()]}, {day}/{m}/{y}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Horário: {s.startTime}</div>
                                        </div>
                                        <button className="btn btn-ghost btn-sm" onClick={() => {
                                            setSelectedSlots(prev => prev.filter(item => !(item.date === s.date && item.startTime === s.startTime)));
                                            if (selectedSlots.length === 1) setStep(1); // Go back if empty
                                        }}>
                                            🗑️ Remover
                                        </button>
                                    </div>
                                )
                            })}
                        </div>

                        {remaining > 0 && (
                            <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '16px', padding: '10px', background: 'rgba(234, 179, 8, 0.1)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(234, 179, 8, 0.2)' }}>
                                💡 Ainda sobram {remaining} créditos para alocar. Você pode guardar para depois ou voltar para adicionar mais agora.
                            </div>
                        )}

                        <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
                            <button className="btn btn-secondary" onClick={() => setStep(1)} disabled={submitting}>
                                ⬅ Adicionar mais
                            </button>
                            <button className="btn btn-primary" onClick={handleConfirm} disabled={submitting}>
                                {submitting ? '⏳ Guardando...' : 'Guardar Agendamentos ✅'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </ModalOverlay>
    );
}
