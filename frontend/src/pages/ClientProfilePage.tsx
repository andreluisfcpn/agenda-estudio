import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usersApi, UserDetail } from '../api/client';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import ProfileHeader from '../components/admin/clients/ProfileHeader';
import ClientDataCard from '../components/admin/clients/ClientDataCard';
import ClientHealthCards from '../components/admin/clients/ClientHealthCards';
import PaymentOverviewCard from '../components/admin/clients/PaymentOverviewCard';
import ClientContractsCard from '../components/admin/clients/ClientContractsCard';
import BookingHistorySection, { BookingNotesPatch } from '../components/admin/clients/BookingHistorySection';
import { ArrowLeft, NotebookPen, Check, UserX, AlertTriangle, Trash2, Loader2 } from 'lucide-react';
import { useUI } from '../context/UIContext';
import { useDeleteClient } from '../hooks/useDeleteClient';
import { getErrorMessage } from '../utils/errors';

/** dd/mm/aaaa no fuso do estúdio. */
const formatSpDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export default function ClientProfilePage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { showToast } = useUI();
    const { requestDelete, previewingId } = useDeleteClient();
    const [user, setUser] = useState<UserDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [notes, setNotes] = useState('');
    const [notesSaving, setNotesSaving] = useState(false);
    const [notesSaved, setNotesSaved] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Observação digitada que ainda não foi ao servidor (o debounce de 1s não disparou). Guarda o id
    // junto: o flush roda no cleanup, com o closure do 1º render.
    const pendingNotesRef = useRef<{ id: string; value: string } | null>(null);

    // Admin payment overview: auto-charge, saved cards, upcoming installments.
    const [payOverview, setPayOverview] = useState<Awaited<ReturnType<typeof usersApi.paymentOverview>> | null>(null);
    const [autoSaving, setAutoSaving] = useState(false);
    useEffect(() => { if (id) loadUser(); }, [id]);

    /**
     * Grava AGORA a observação pendente do debounce, em vez de descartá-la (sair da página, trocar de
     * cliente, abrir a exclusão). Só lê refs e o showToast global (estável): seguro no cleanup.
     */
    const flushNotes = useCallback((): Promise<void> => {
        if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
        const pending = pendingNotesRef.current;
        if (!pending) return Promise.resolve();
        pendingNotesRef.current = null;
        return usersApi.update(pending.id, { notes: pending.value }).then(() => undefined, (err: unknown) => {
            showToast({ message: getErrorMessage(err) || 'Não foi possível salvar as observações.', type: 'error' });
        });
    }, [showToast]);
    // Saiu da página (ou trocou de cliente) com nota pendente → salva, não descarta.
    useEffect(() => () => { void flushNotes(); }, [id, flushNotes]);

    const handleAutoCharge = async (enabled: boolean) => {
        setAutoSaving(true);
        try {
            const r = await usersApi.setAutoCharge(id!, enabled);
            setPayOverview(p => (p ? { ...p, autoChargeEnabled: r.autoChargeEnabled } : p));
        } catch (err) {
            showToast({ message: getErrorMessage(err) || 'Não foi possível alterar a cobrança automática.', type: 'error' });
        }
        finally { setAutoSaving(false); }
    };

    // silent=true: refetch após um save inline — NÃO pisca o skeleton (evita
    // desmontar/reinicializar os editores e perder edição em andamento).
    const loadUser = async (silent = false) => {
        if (!silent) setLoading(true);
        setLoadError(false);
        try {
            const res = await usersApi.getById(id!);
            setUser(res.user);
            setNotes(res.user.notes || '');
            // Cliente excluído (D3): sem cartões nem cobrança automática — não há visão de pagamento a buscar.
            if (res.user.deletedAt) setPayOverview(null);
            else usersApi.paymentOverview(id!).then(setPayOverview).catch(() => setPayOverview(null));
        } catch (err) { console.error(err); setLoadError(true); }
        finally { if (!silent) setLoading(false); }
    };

    const handleNotesChange = (value: string) => {
        setNotes(value);
        setNotesSaved(false);
        pendingNotesRef.current = { id: id!, value };
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            debounceRef.current = null;
            const pending = pendingNotesRef.current;
            if (!pending) return;
            pendingNotesRef.current = null;
            setNotesSaving(true);
            try {
                await usersApi.update(pending.id, { notes: pending.value });
                setNotesSaved(true);
                setTimeout(() => setNotesSaved(false), 2000);
            } catch (err) {
                showToast({ message: getErrorMessage(err) || 'Não foi possível salvar as observações.', type: 'error' });
            }
            finally { setNotesSaving(false); }
        }, 1000);
    };

    const handleBookingUpdated = (bookingId: string, patch: BookingNotesPatch) => {
        setUser(u => u ? { ...u, bookings: u.bookings.map(b => b.id === bookingId ? { ...b, ...patch } : b) } : u);
    };

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={4} cols={3} /></div>;
    // U4: distinguish a load failure from a genuinely missing user — a network error must not
    // read as "Usuário não encontrado" (which implies the client was deleted).
    if (loadError && !user) return (
        <div className="card"><div className="empty-state" role="alert">
            <div className="empty-state-text">Não foi possível carregar o perfil do cliente.</div>
            <button className="btn btn-primary btn-sm" style={{ marginTop: 10 }} onClick={() => loadUser()}>Tentar novamente</button>
        </div></div>
    );
    if (!user) return <div className="card"><div className="empty-state"><div className="empty-state-text">Usuário não encontrado</div></div></div>;

    // D3: cliente excluído (soft delete) = perfil só-histórico. O PATCH do cadastro responde 409,
    // então editores, notas, cobrança automática e a Zona de perigo ficam ocultos.
    const isDeleted = !!user.deletedAt;
    const canDelete = !isDeleted && user.role !== 'ADMIN';
    const deleting = previewingId === user.id;

    const handleDelete = async () => {
        // A observação pendente é SALVA antes da prévia: se o admin desistir, nada se perde; se
        // confirmar, o soft delete apaga as notas junto com os demais dados pessoais (D3).
        await flushNotes();
        void requestDelete({ id: user.id, name: user.name }, () => navigate('/admin/clients'));
    };

    return (
        <div>
            <div style={{ marginBottom: '16px' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/clients')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ArrowLeft size={15} aria-hidden="true" /> Voltar para Clientes</button>
            </div>

            {isDeleted && (
                <div className="admin-alert admin-alert--danger" role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16 }}>
                    <UserX size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div>
                        <div>Cliente excluído em {formatSpDate(user.deletedAt!)} — somente histórico</div>
                        <div style={{ fontWeight: 400, color: 'var(--text-secondary)', marginTop: 2 }}>
                            Os dados pessoais foram apagados e o cadastro não pode mais ser alterado. Contratos, gravações e pagamentos ficam aqui só para consulta.
                        </div>
                    </div>
                </div>
            )}

            <ProfileHeader user={user} />

            {!isDeleted && <ClientDataCard user={user} onSaved={() => loadUser(true)} />}

            <ClientHealthCards user={user} />

            {!isDeleted && payOverview && (
                <PaymentOverviewCard overview={payOverview} autoSaving={autoSaving} onToggleAutoCharge={handleAutoCharge} />
            )}

            {/* bookings: o avulso mostra a data/horário REAIS da gravação (a remarcação move a reserva, não o contrato). */}
            <ClientContractsCard contracts={user.contracts} bookings={user.bookings} />

            {/* Notes — Full Width */}
            {!isDeleted && (
            <div className="card" style={{ padding: '20px', marginBottom: '16px' }}>
                <h2 style={{ fontSize: '1.0625rem', fontWeight: 700, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <NotebookPen size={17} aria-hidden="true" /> Observações do Cliente
                    {notesSaving && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Salvando...</span>}
                    {notesSaved && <span style={{ fontSize: '0.75rem', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Check size={13} aria-hidden="true" /> Salvo</span>}
                </h2>
                <textarea
                    className="form-input"
                    style={{ minHeight: 120, resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
                    placeholder="Anotações internas sobre o cliente..."
                    aria-label="Observações do cliente"
                    value={notes}
                    onChange={e => handleNotesChange(e.target.value)}
                />
            </div>
            )}

            <BookingHistorySection bookings={user.bookings} onBookingUpdated={handleBookingUpdated} />

            {/* Zona de perigo (D3): mesmo fluxo da lista — prévia real → digitar EXCLUIR → excluir. */}
            {canDelete && (
                <section aria-labelledby="client-danger-zone-title" style={{
                    padding: '20px', marginTop: '24px', marginBottom: '16px', borderRadius: 'var(--radius-lg)',
                    background: 'var(--bg-card)', border: '1px solid var(--danger-bg)',
                    borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)',
                }}>
                    <h2 id="client-danger-zone-title" style={{ fontSize: '1.0625rem', fontWeight: 700, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)' }}>
                        <AlertTriangle size={17} aria-hidden="true" /> Zona de perigo
                    </h2>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px 20px', flexWrap: 'wrap' }}>
                        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: '0.875rem' }}>Excluir cliente</div>
                            <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                Sem nada vinculado, o cadastro é apagado de vez. Com histórico, os dados pessoais são apagados e contratos em andamento, gravações futuras e cobranças pendentes são cancelados; o que já foi pago continua no financeiro. Não é possível desfazer.
                            </p>
                        </div>
                        <button type="button" className="btn btn-danger" onClick={() => void handleDelete()}
                            disabled={previewingId !== null} aria-busy={deleting || undefined}
                            style={{ flexShrink: 0, minHeight: 44 }}>
                            {deleting
                                ? <Loader2 size={16} className="danger-dialog__spinner" aria-hidden="true" />
                                : <Trash2 size={16} aria-hidden="true" />}
                            Excluir cliente
                        </button>
                    </div>
                </section>
            )}
        </div>
    );
}
