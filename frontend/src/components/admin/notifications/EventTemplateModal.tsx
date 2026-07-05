import { useState, useRef } from 'react';
import { notificationsAdminApi, NotificationEventDef } from '../../../api/client';
import { useUI } from '../../../context/UIContext';
import { getErrorMessage } from '../../../utils/errors';
import BottomSheetModal from '../../BottomSheetModal';
import ToggleSwitch from '../../ui/ToggleSwitch';
import { Bell, Save, Send, RotateCcw, X } from 'lucide-react';

interface Props {
    event: NotificationEventDef;
    onClose: () => void;
    onSaved: () => void;
}

type SeverityChoice = 'auto' | 'critical' | 'warning' | 'info';

/** Replace {name} → example for the live preview. */
function renderPreview(text: string, vars: { name: string; example: string }[]): string {
    return text.replace(/\{(\w+)\}/g, (m, k) => vars.find(v => v.name === k)?.example ?? m);
}

export default function EventTemplateModal({ event, onClose, onSaved }: Props) {
    const { showToast } = useUI();
    const isDynamic = event.defaults.severity === 'dynamic';

    const [enabled, setEnabled] = useState(event.effective.enabled);
    const [title, setTitle] = useState(event.effective.title);
    const [message, setMessage] = useState(event.effective.message);
    const [severity, setSeverity] = useState<SeverityChoice>(
        event.overrides?.severity ? (event.overrides.severity as SeverityChoice) : (isDynamic ? 'auto' : (event.effective.severity as SeverityChoice))
    );
    const [pushEnabled, setPushEnabled] = useState(event.effective.pushEnabled);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);

    const titleRef = useRef<HTMLInputElement>(null);
    const msgRef = useRef<HTMLTextAreaElement>(null);
    const lastFocused = useRef<'title' | 'message'>('message');

    // Insert {name} at the cursor of whichever field was last focused.
    const insertVar = (name: string) => {
        const token = `{${name}}`;
        if (lastFocused.current === 'title' && titleRef.current) {
            const el = titleRef.current;
            const s = el.selectionStart ?? title.length, e = el.selectionEnd ?? title.length;
            const next = title.slice(0, s) + token + title.slice(e);
            setTitle(next);
            requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + token.length, s + token.length); });
        } else {
            const el = msgRef.current;
            const s = el?.selectionStart ?? message.length, e = el?.selectionEnd ?? message.length;
            const next = message.slice(0, s) + token + message.slice(e);
            setMessage(next);
            requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + token.length, s + token.length); });
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await notificationsAdminApi.updateTemplate(event.eventKey, {
                enabled,
                title: title.trim(),
                message: message.trim(),
                severity: severity === 'auto' ? null : severity,
                pushEnabled,
            });
            showToast('Notificação atualizada!');
            onSaved();
        } catch (err) {
            showToast({ message: getErrorMessage(err), type: 'error' });
        } finally { setSaving(false); }
    };

    const handleTest = async () => {
        setTesting(true);
        try {
            // Save first so the test reflects the current draft.
            await notificationsAdminApi.updateTemplate(event.eventKey, {
                enabled, title: title.trim(), message: message.trim(),
                severity: severity === 'auto' ? null : severity, pushEnabled,
            });
            await notificationsAdminApi.test(event.eventKey);
            showToast('Teste enviado para o seu sino.');
            onSaved();
        } catch (err) {
            showToast({ message: getErrorMessage(err), type: 'error' });
        } finally { setTesting(false); }
    };

    const handleReset = async () => {
        setSaving(true);
        try {
            await notificationsAdminApi.resetTemplate(event.eventKey);
            showToast('Restaurado para o padrão.');
            onSaved();
        } catch (err) {
            showToast({ message: getErrorMessage(err), type: 'error' });
        } finally { setSaving(false); }
    };

    const previewTitle = renderPreview(title, event.variables);
    const previewMsg = renderPreview(message, event.variables);
    // Backend requires non-empty title/message; guard here so Save/Test don't 400 opaquely.
    const canSave = title.trim().length > 0 && message.trim().length > 0;

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="md" className="admin-sheet" title={event.label}>
            <div className="notif-template-head">
                <h2 className="notif-template-head__title">
                    <span className="notif-template-head__icon"><Bell size={18} aria-hidden="true" /></span>
                    {event.label}
                </h2>
                <button className="notif-template-head__close" onClick={onClose} aria-label="Fechar"><X size={18} /></button>
                <p className="notif-template-head__desc">{event.description}</p>
            </div>

            <div className="notif-template-form">
                {/* Enabled */}
                <div className="notif-template-row">
                    <div>
                        <div className="notif-template-row__label">Ativa</div>
                        <div className="notif-template-row__hint">Quando desligada, este evento não gera notificação.</div>
                    </div>
                    <ToggleSwitch checked={enabled} onChange={setEnabled} label={enabled ? 'Sim' : 'Não'} />
                </div>

                <div className="form-group">
                    <label className="form-label">Título</label>
                    <input
                        ref={titleRef}
                        className="form-input"
                        value={title}
                        onFocus={() => { lastFocused.current = 'title'; }}
                        onChange={e => setTitle(e.target.value)}
                        maxLength={120}
                    />
                </div>

                <div className="form-group">
                    <label className="form-label">Mensagem</label>
                    <textarea
                        ref={msgRef}
                        className="form-input"
                        rows={3}
                        value={message}
                        onFocus={() => { lastFocused.current = 'message'; }}
                        onChange={e => setMessage(e.target.value)}
                        maxLength={1000}
                        style={{ resize: 'vertical' }}
                    />
                </div>

                {event.variables.length > 0 && (
                    <div className="notif-var-chips">
                        <span className="notif-var-chips__label">Variáveis:</span>
                        {event.variables.map(v => (
                            <button key={v.name} type="button" className="notif-var-chip" onClick={() => insertVar(v.name)} title={`${v.label} — ex.: ${v.example}`}>
                                {'{'}{v.name}{'}'}
                            </button>
                        ))}
                    </div>
                )}

                {/* Live preview */}
                <div className="notif-template-preview">
                    <div className="notif-template-preview__label">Prévia</div>
                    <div className="notif-template-preview__title">{previewTitle}</div>
                    <div className="notif-template-preview__msg">{previewMsg}</div>
                </div>

                {/* Severity */}
                <div className="form-group">
                    <label className="form-label">Severidade</label>
                    <div className="notif-seg">
                        {([...(isDynamic ? ['auto'] : []), 'critical', 'warning', 'info'] as SeverityChoice[]).map(s => (
                            <button
                                key={s}
                                type="button"
                                className={`notif-seg__btn ${severity === s ? 'notif-seg__btn--active' : ''}`}
                                onClick={() => setSeverity(s)}
                            >
                                {s === 'auto' ? 'Automática' : s === 'critical' ? 'Crítica' : s === 'warning' ? 'Aviso' : 'Info'}
                            </button>
                        ))}
                    </div>
                    {severity === 'auto' && <div className="notif-template-row__hint">A severidade é calculada em tempo real (ex.: fica crítica perto do prazo).</div>}
                </div>

                {/* Push */}
                <div className="notif-template-row">
                    <div>
                        <div className="notif-template-row__label">Enviar push</div>
                        <div className="notif-template-row__hint">Notificação no navegador/celular além do sino.</div>
                    </div>
                    <ToggleSwitch checked={pushEnabled} onChange={setPushEnabled} label={pushEnabled ? 'Sim' : 'Não'} />
                </div>

                <div className="notif-template-actions">
                    <button className="btn-admin-ghost" onClick={handleReset} disabled={saving || testing} title="Restaurar o texto padrão">
                        <RotateCcw size={15} /> Padrão
                    </button>
                    <button className="btn-admin-ghost" onClick={handleTest} disabled={saving || testing || !canSave}>
                        <Send size={15} /> {testing ? 'Enviando…' : 'Enviar teste'}
                    </button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving || testing || !canSave}>
                        <Save size={16} /> {saving ? 'Salvando…' : 'Salvar'}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}
