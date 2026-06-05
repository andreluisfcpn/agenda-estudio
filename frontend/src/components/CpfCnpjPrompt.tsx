import { useState } from 'react';
import { ShieldCheck, Check, CreditCard } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';
import { maskCpfCnpj, isValidCpfCnpj } from '../utils/mask';
import { getErrorMessage } from '../utils/errors';

interface CpfCnpjPromptProps {
    /** Called after the document is successfully saved — re-run the payment here. */
    onSaved: () => void;
    onCancel?: () => void;
    title?: string;
    subtitle?: string;
    /** Label of the primary button (e.g. "Salvar e gerar PIX"). */
    saveLabel?: string;
}

/**
 * Inline CPF/CNPJ collection card shown before a PIX charge when the user has no
 * valid document on file. Validates the check digits client-side, persists via
 * PATCH /auth/profile, refreshes the auth context, then calls onSaved().
 */
export default function CpfCnpjPrompt({ onSaved, onCancel, title, subtitle, saveLabel }: CpfCnpjPromptProps) {
    const { user, updateUser } = useAuth();
    const [value, setValue] = useState(user?.cpfCnpj ? maskCpfCnpj(user.cpfCnpj) : '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [touched, setTouched] = useState(false);

    const digits = value.replace(/\D/g, '');
    const valid = isValidCpfCnpj(value);
    const docType = digits.length > 11 ? 'CNPJ' : 'CPF';
    const showError = touched && digits.length >= 11 && !valid;

    const handleSave = async () => {
        if (!valid || saving) return;
        setSaving(true);
        setError('');
        try {
            const res = await authApi.updateProfile({ cpfCnpj: digits });
            updateUser(res.user);
            onSaved();
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Não foi possível salvar. Tente novamente.');
            setSaving(false);
        }
    };

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
            padding: '8px 4px',
        }}>
            <div style={{
                width: 56, height: 56, borderRadius: 16, marginBottom: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(34,197,94,0.12)', color: '#22c55e',
            }}>
                <CreditCard size={26} />
            </div>

            <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 6px' }}>
                {title || 'Confirme seu CPF ou CNPJ'}
            </h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5, margin: '0 0 18px', maxWidth: 340 }}>
                {subtitle || 'O PIX é emitido como uma cobrança no seu nome — por isso precisamos do seu CPF ou CNPJ. É rápido, e fica salvo no seu perfil para as próximas vezes.'}
            </p>

            <div className="form-group" style={{ width: '100%', textAlign: 'left', marginBottom: showError || error ? 6 : 14 }}>
                <label className="form-label">CPF / CNPJ</label>
                <div style={{ position: 'relative' }}>
                    <input
                        className="form-input"
                        value={value}
                        onChange={e => { setValue(maskCpfCnpj(e.target.value)); if (error) setError(''); }}
                        onBlur={() => setTouched(true)}
                        inputMode="numeric"
                        autoComplete="off"
                        placeholder="000.000.000-00"
                        style={{
                            paddingRight: 40,
                            borderColor: showError ? '#ef4444' : valid ? '#22c55e' : undefined,
                        }}
                    />
                    {valid && (
                        <Check size={18} style={{
                            position: 'absolute', right: 13, top: '50%', transform: 'translateY(-50%)', color: '#22c55e',
                        }} />
                    )}
                </div>
            </div>

            {showError && (
                <div style={{ width: '100%', textAlign: 'left', fontSize: '0.75rem', color: '#ef4444', marginBottom: 12 }}>
                    {docType} inválido — confira os números.
                </div>
            )}
            {error && <div className="checkout-error" style={{ width: '100%', marginBottom: 12 }}>{error}</div>}

            <button
                onClick={handleSave}
                disabled={!valid || saving}
                className="checkout-pay-btn checkout-pay-btn--pix"
                style={{ width: '100%', opacity: !valid || saving ? 0.55 : 1, cursor: !valid || saving ? 'default' : 'pointer' }}
            >
                {saving
                    ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Salvando...</>
                    : <><ShieldCheck size={16} /> {saveLabel || 'Salvar e continuar'}</>}
            </button>

            {onCancel && (
                <button onClick={onCancel} className="checkout-cancel-btn" style={{ marginTop: 4 }}>
                    Cancelar
                </button>
            )}
        </div>
    );
}
