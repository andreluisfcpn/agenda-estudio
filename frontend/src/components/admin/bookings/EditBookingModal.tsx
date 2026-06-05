import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, BookingWithUser } from '../../../api/client';
import ModalOverlay from '../../ModalOverlay';
import { formatBRL } from '../../../utils/format';

const TIER_EMOJI: Record<string, string> = { COMERCIAL: '🏢', AUDIENCIA: '🎤', SABADO: '🌟' };
const TIER_COLORS: Record<string, { color: string; bg: string }> = {
    COMERCIAL: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
    AUDIENCIA: { color: '#2dd4bf', bg: 'rgba(45,212,191,0.12)' },
    SABADO: { color: '#fbbf24', bg: 'rgba(245,158,11,0.12)' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
    COMPLETED:     { label: 'Concluído',      color: '#10b981', bg: 'rgba(16,185,129,0.12)',  icon: '✅' },
    CONFIRMED:     { label: 'Confirmado',     color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  icon: '✅' },
    RESERVED:      { label: 'Reservado',      color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '⏳' },
    CANCELLED:     { label: 'Cancelado',      color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '🚫' },
    FALTA:         { label: 'Falta',          color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '❌' },
    NAO_REALIZADO: { label: 'Não Realizado',  color: '#14b8a6', bg: 'rgba(45,212,191,0.12)',  icon: '❌' },
};

interface EditBookingModalProps {
    booking: BookingWithUser | null;
    onClose: () => void;
    onSaved: () => void;
}

export default function EditBookingModal({ booking, onClose, onSaved }: EditBookingModalProps) {
    const [editForm, setEditForm] = useState({ date: '', startTime: '', status: '' });
    const [editError, setEditError] = useState('');

    useEffect(() => {
        if (booking) {
            setEditForm({ date: booking.date.split('T')[0], startTime: booking.startTime, status: booking.status });
            setEditError('');
        }
    }, [booking]);

    const handleEdit = async () => {
        if (!booking) return;
        setEditError('');
        try {
            const data: any = {};
            if (editForm.date) data.date = editForm.date;
            if (editForm.startTime) data.startTime = editForm.startTime;
            if (editForm.status) data.status = editForm.status;
            await bookingsApi.update(booking.id, data);
            onSaved();
            onClose();
        } catch (err: unknown) { setEditError(getErrorMessage(err)); }
    };

    if (!booking) return null;

    return (
        <ModalOverlay onClose={onClose}>
            <div className="modal" style={{ maxWidth: 520, padding: 0, overflow: 'hidden' }}>
                {/* Header */}
                <div style={{ padding: '24px 28px 0' }}>
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{
                            width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'linear-gradient(135deg, #10b981, #11819B)', fontSize: '0.9rem'
                        }}>✏️</span>
                        Editar Agendamento
                    </h2>
                    {/* Client info bar */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: '10px', marginTop: '16px',
                        padding: '10px 14px', borderRadius: '10px',
                        background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                    }}>
                        <div style={{
                            width: 30, height: 30, borderRadius: '50%',
                            background: 'linear-gradient(135deg, #10b981, #11819B)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.75rem', fontWeight: 700, color: '#fff', flexShrink: 0,
                        }}>{booking.user.name.charAt(0).toUpperCase()}</div>
                        <div>
                            <div style={{ fontWeight: 700, fontSize: '0.8125rem' }}>{booking.user.name}</div>
                            <div style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>{booking.user.email}</div>
                        </div>
                        {booking.contract && (
                            <span style={{
                                marginLeft: 'auto', fontSize: '0.625rem', fontWeight: 700,
                                padding: '2px 8px', borderRadius: '6px',
                                background: TIER_COLORS[booking.contract.tier]?.bg || 'var(--bg-elevated)',
                                color: TIER_COLORS[booking.contract.tier]?.color || 'var(--text-muted)',
                            }}>
                                {TIER_EMOJI[booking.contract.tier]} {booking.contract.name}
                            </span>
                        )}
                    </div>
                </div>

                {/* Form */}
                <div style={{ padding: '20px 28px 24px' }}>
                    {editError && <div style={{ marginBottom: '14px', padding: '10px 14px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600 }}>{editError}</div>}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '16px' }}>
                        {/* Date */}
                        <div>
                            <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px', display: 'block' }}>📅 Data</label>
                            <input type="date" value={editForm.date}
                                min={new Date().toISOString().split('T')[0]}
                                onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                                style={{
                                    width: '100%', padding: '9px 12px', borderRadius: '10px', fontSize: '0.8125rem', fontWeight: 600,
                                    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                    color: 'var(--text-primary)', outline: 'none',
                                }}
                            />
                        </div>
                        {/* Time */}
                        <div>
                            <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '6px', display: 'block' }}>⏰ Horário</label>
                            <input type="time" step="1800" value={editForm.startTime}
                                onChange={e => setEditForm({ ...editForm, startTime: e.target.value })}
                                style={{
                                    width: '100%', padding: '9px 12px', borderRadius: '10px', fontSize: '0.8125rem', fontWeight: 600,
                                    background: 'var(--bg-elevated)', border: '1px solid var(--border-default)',
                                    color: 'var(--text-primary)', outline: 'none',
                                }}
                            />
                        </div>
                    </div>

                    {/* Status */}
                    <div style={{ marginBottom: '16px' }}>
                        <label style={{ fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '8px', display: 'block' }}>Status</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                                <button key={key}
                                    onClick={() => setEditForm({ ...editForm, status: key })}
                                    style={{
                                        padding: '6px 12px', borderRadius: '8px', fontSize: '0.6875rem', fontWeight: 600, cursor: 'pointer',
                                        background: editForm.status === key ? cfg.bg : 'var(--bg-elevated)',
                                        border: `1px solid ${editForm.status === key ? cfg.color + '44' : 'var(--border-default)'}`,
                                        color: editForm.status === key ? cfg.color : 'var(--text-muted)',
                                        transition: 'all 0.15s',
                                    }}
                                >
                                    {cfg.icon} {cfg.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Info summary */}
                    <div style={{
                        padding: '10px 14px', borderRadius: '10px', marginBottom: '16px',
                        background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)',
                        fontSize: '0.75rem', color: 'var(--text-muted)',
                        display: 'flex', justifyContent: 'space-between',
                    }}>
                        <span>💰 Valor: <strong style={{ color: '#10b981' }}>{formatBRL(booking.price)}</strong></span>
                        <span>{TIER_EMOJI[booking.tierApplied]} {booking.tierApplied}</span>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <button onClick={onClose}
                            style={{ padding: '9px 18px', borderRadius: '10px', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '0.8125rem', fontWeight: 600, cursor: 'pointer' }}>
                            Cancelar
                        </button>
                        <button onClick={handleEdit}
                            style={{
                                padding: '10px 24px', borderRadius: '10px', border: 'none', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer',
                                background: 'linear-gradient(135deg, #10b981, #11819B)', color: '#fff',
                                display: 'flex', alignItems: 'center', gap: '8px',
                            }}>
                            💾 Salvar Alterações
                        </button>
                    </div>
                </div>
            </div>
        </ModalOverlay>
    );
}
