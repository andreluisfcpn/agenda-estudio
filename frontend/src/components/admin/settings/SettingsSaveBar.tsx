import { Save, Loader2 } from 'lucide-react';

interface SettingsSaveBarProps {
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
    /** When two save bars can coexist (financeiro), stack this one above the base. */
    stacked?: boolean;
}

/**
 * Floating "unsaved changes" save bar — mirrors the markup used by the legacy
 * AdminPricingPage so the look/behavior is identical. Rendered by each section
 * only when that section is dirty (no shared cross-section state).
 */
export default function SettingsSaveBar({ saving, onSave, onDiscard, stacked }: SettingsSaveBarProps) {
    return (
        <div className={`admin-save-bar${stacked ? ' admin-save-bar--stacked' : ''}`} style={{
            display: 'flex', justifyContent: 'flex-end', gap: '12px',
            padding: '14px 24px',
            background: 'var(--bg-secondary)',
            borderRadius: '14px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            border: '1px solid rgba(16,185,129,0.3)',
        }}>
            <span style={{
                alignSelf: 'center', fontSize: '0.8125rem', marginRight: 'auto',
                color: '#f59e0b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px',
            }}>
                <span style={{
                    width: 8, height: 8, borderRadius: '50%', background: '#f59e0b',
                    animation: 'today-pulse 2s infinite', display: 'inline-block',
                }} />
                Alterações não salvas
            </span>
            <button className="btn btn-secondary" onClick={onDiscard} style={{ borderRadius: '10px' }}>Descartar</button>
            <button className="btn btn-primary" onClick={onSave} disabled={saving}
                style={{ borderRadius: '10px', padding: '8px 20px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {saving
                    ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Salvando...</>
                    : <><Save size={16} /> Salvar Alterações</>}
            </button>
        </div>
    );
}

interface SettingsMessagesProps {
    error: string;
    success: string;
}

/** Error / success banners reused from the legacy pages. */
export function SettingsMessages({ error, success }: SettingsMessagesProps) {
    return (
        <>
            {error && (
                <div style={{
                    padding: '12px 16px', marginBottom: '16px', borderRadius: '12px',
                    background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                    color: '#ef4444', fontSize: '0.8125rem', fontWeight: 600
                }}>⚠️ {error}</div>
            )}
            {success && (
                <div style={{
                    padding: '12px 16px', marginBottom: '16px', borderRadius: '12px',
                    background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
                    color: '#10b981', fontSize: '0.8125rem', fontWeight: 600
                }}>{success}</div>
            )}
        </>
    );
}
