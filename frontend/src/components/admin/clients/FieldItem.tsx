import { useState, useEffect } from 'react';
import { usersApi } from '../../../api/client';
import { useUI } from '../../../context/UIContext';

const SAVE_ERROR = { message: 'Não foi possível salvar. Tente novamente.', type: 'error' as const };

interface FieldItemProps {
    label: string;
    value: string | null;
    field: string;
    userId: string;
    onSaved: () => void;
}

/** Campo com edição inline (clique para editar, salva no blur/Enter). */
export default function FieldItem({ label, value, field, userId, onSaved }: FieldItemProps) {
    const { showToast } = useUI();
    const [editing, setEditing] = useState(false);
    const [val, setVal] = useState(value || '');
    useEffect(() => setVal(value || ''), [value]);
    const save = async () => {
        setEditing(false);
        if (val !== (value || '')) { try { await usersApi.update(userId, { [field]: val || null } as any); onSaved(); } catch { showToast(SAVE_ERROR); } }
    };
    return (
        <div>
            <div style={{ fontSize: '0.6875rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
            {editing ? (
                <input className="form-input" value={val} onChange={e => setVal(e.target.value)} onBlur={save} onKeyDown={e => e.key === 'Enter' && save()} autoFocus
                    style={{ fontSize: '0.8125rem', padding: '6px 8px' }} />
            ) : (
                <div role="button" tabIndex={0} aria-label={`Editar ${label}`}
                    onClick={() => setEditing(true)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing(true); } }}
                    style={{ cursor: 'pointer', fontSize: '0.8125rem', padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border-color)', minHeight: '32px', color: val ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {val || 'Clique para editar'}
                </div>
            )}
        </div>
    );
}
