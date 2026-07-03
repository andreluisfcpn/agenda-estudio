import { getErrorMessage } from '../../../utils/errors';
import { useState, useEffect } from 'react';
import { bookingsApi, BookingWithUser } from '../../../api/client';
import BottomSheetModal from '../../BottomSheetModal';
import { formatBRL } from '../../../utils/format';
import { TIER_META, BOOKING_STATUS_META } from '../../../constants/adminMeta';
import { Pencil, CalendarDays, Clock, Wallet } from 'lucide-react';

// Statuses selecionáveis neste modal — cores/labels/ícones vêm do adminMeta
// (source of truth); HELD é interno do fluxo de pagamento e fica de fora.
const EDITABLE_STATUSES = Object.fromEntries(
    Object.entries(BOOKING_STATUS_META).filter(([key]) => key !== 'HELD')
);

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
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="md" className="admin-sheet" title="Editar Agendamento">
                {/* Header */}
                <div className="admin-modal-head">
                    <h2 className="admin-modal-title">
                        <span className="admin-modal-title__icon"><Pencil size={16} aria-hidden="true" /></span>
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
                            background: 'var(--accent-gradient-go)',
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
                                background: TIER_META[booking.contract.tier]?.bg || 'var(--bg-elevated)',
                                color: TIER_META[booking.contract.tier]?.color || 'var(--text-muted)',
                            }}>
                                {(() => { const TI = TIER_META[booking.contract!.tier]?.icon; return TI ? <TI size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} aria-hidden="true" /> : null; })()}{booking.contract.name}
                            </span>
                        )}
                    </div>
                </div>

                {/* Form */}
                <div className="admin-modal-body">
                    {editError && <div className="admin-alert admin-alert--danger" role="alert">{editError}</div>}

                    <div className="admin-grid-2" style={{ marginBottom: '16px' }}>
                        {/* Date */}
                        <div className="admin-field">
                            <label className="admin-field__label" htmlFor="edit-booking-date" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><CalendarDays size={13} aria-hidden="true" /> Data</label>
                            <input id="edit-booking-date" type="date" value={editForm.date}
                                min={new Date().toISOString().split('T')[0]}
                                onChange={e => setEditForm({ ...editForm, date: e.target.value })}
                                className="form-input form-input--raised"
                            />
                        </div>
                        {/* Time */}
                        <div className="admin-field">
                            <label className="admin-field__label" htmlFor="edit-booking-time" style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={13} aria-hidden="true" /> Horário</label>
                            <input id="edit-booking-time" type="time" step="1800" value={editForm.startTime}
                                onChange={e => setEditForm({ ...editForm, startTime: e.target.value })}
                                className="form-input form-input--raised"
                            />
                        </div>
                    </div>

                    {/* Status */}
                    <div className="admin-field" style={{ marginBottom: '16px' }}>
                        <span className="admin-field__label">Status</span>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }} role="group" aria-label="Status do agendamento">
                            {Object.entries(EDITABLE_STATUSES).map(([key, cfg]) => {
                                const Icon = cfg.icon;
                                return (
                                    <button key={key}
                                        onClick={() => setEditForm({ ...editForm, status: key })}
                                        aria-pressed={editForm.status === key}
                                        style={{
                                            padding: '8px 12px', borderRadius: '8px', fontSize: '0.6875rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                                            display: 'inline-flex', alignItems: 'center', gap: '6px',
                                            background: editForm.status === key ? cfg.bg : 'var(--bg-elevated)',
                                            border: `1px solid ${editForm.status === key ? cfg.color + '44' : 'var(--border-default)'}`,
                                            color: editForm.status === key ? cfg.color : 'var(--text-muted)',
                                            transition: 'background 0.15s ease, color 0.15s ease, border-color 0.15s ease',
                                        }}
                                    >
                                        <Icon size={12} aria-hidden="true" /> {cfg.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Info summary */}
                    <div style={{
                        padding: '10px 14px', borderRadius: '10px', marginBottom: '16px',
                        background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.1)',
                        fontSize: '0.75rem', color: 'var(--text-muted)',
                        display: 'flex', justifyContent: 'space-between',
                    }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Wallet size={12} aria-hidden="true" /> Valor: <strong style={{ color: 'var(--success)' }}>{formatBRL(booking.price)}</strong></span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{(() => { const TI = TIER_META[booking.tierApplied]?.icon; return TI ? <TI size={12} aria-hidden="true" /> : null; })()} {booking.tierApplied}</span>
                    </div>

                    {/* Actions */}
                    <div className="admin-actions-row">
                        <button onClick={onClose} className="btn-admin-ghost">
                            Cancelar
                        </button>
                        <button onClick={handleEdit} className="btn-admin-go">
                            Salvar Alterações
                        </button>
                    </div>
                </div>
        </BottomSheetModal>
    );
}
