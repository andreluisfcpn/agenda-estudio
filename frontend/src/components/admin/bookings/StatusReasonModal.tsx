import { useState, useEffect, useId } from 'react';
import BottomSheetModal from '../../BottomSheetModal';
import { AlertTriangle, XCircle, NotebookPen } from 'lucide-react';

export type ReasonKind = 'FALTA' | 'NAO_REALIZADO';

interface Props {
    isOpen: boolean;
    kind: ReasonKind | null;
    /** Nome do cliente/gravação, só para contexto no cabeçalho. */
    subtitle?: string;
    onConfirm: (reason: string) => void | Promise<void>;
    onClose: () => void;
    saving?: boolean;
}

const META: Record<ReasonKind, { title: string; icon: typeof AlertTriangle; color: string; hint: string; placeholder: string; confirmLabel: string }> = {
    FALTA: {
        title: 'Marcar Falta',
        icon: XCircle,
        color: 'var(--danger)',
        hint: 'O cliente faltou. Ele PERDE o valor/crédito desta gravação. Descreva o que aconteceu.',
        placeholder: 'Ex.: cliente não compareceu e não avisou.',
        confirmLabel: 'Confirmar Falta',
    },
    NAO_REALIZADO: {
        title: 'Marcar Não Realizado',
        icon: AlertTriangle,
        color: 'var(--warning)',
        hint: 'A gravação não aconteceu por um motivo alheio ao cliente. O crédito é LIBERADO — no avulso ele pode reagendar; nos demais planos o crédito volta / a vaga é liberada. Descreva o motivo.',
        placeholder: 'Ex.: queda de energia no estúdio / falha de equipamento.',
        confirmLabel: 'Confirmar Não Realizado',
    },
};

export default function StatusReasonModal({ isOpen, kind, subtitle, onConfirm, onClose, saving }: Props) {
    const uid = useId();
    const [reason, setReason] = useState('');

    useEffect(() => { if (isOpen) setReason(''); }, [isOpen, kind]);

    if (!isOpen || !kind) return null;
    const meta = META[kind];
    const Icon = meta.icon;
    const canConfirm = reason.trim().length >= 3 && !saving;

    return (
        <BottomSheetModal isOpen onClose={onClose} hideHeader size="sm" className="admin-sheet" title={meta.title}>
            <div style={{ padding: '24px 28px 28px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 800, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Icon size={18} style={{ color: meta.color }} aria-hidden="true" /> {meta.title}
                </h2>
                {subtitle && <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 12px' }}>{subtitle}</p>}

                <div style={{ padding: '10px 14px', borderRadius: 10, marginBottom: 16, background: `${meta.color}14`, border: `1px solid ${meta.color}33`, fontSize: '0.75rem', color: meta.color, fontWeight: 600, lineHeight: 1.5 }}>
                    {meta.hint}
                </div>

                <label htmlFor={`${uid}-reason`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.6875rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                    <NotebookPen size={13} aria-hidden="true" /> Motivo (obrigatório)
                </label>
                <textarea
                    id={`${uid}-reason`}
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder={meta.placeholder}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 10, fontSize: '0.8125rem', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit', resize: 'vertical' }}
                />

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                    <button onClick={onClose} disabled={saving} className="btn-admin-ghost">Cancelar</button>
                    <button
                        onClick={() => canConfirm && onConfirm(reason.trim())}
                        disabled={!canConfirm}
                        className="btn-admin-go"
                        style={{ background: canConfirm ? meta.color : undefined, opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? 'pointer' : 'not-allowed' }}
                    >
                        {saving ? 'Salvando…' : <><Icon size={15} aria-hidden="true" /> {meta.confirmLabel}</>}
                    </button>
                </div>
            </div>
        </BottomSheetModal>
    );
}
