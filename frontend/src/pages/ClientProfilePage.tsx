import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usersApi, UserDetail } from '../api/client';
import { HeroSkeleton, TableSkeleton } from '../components/ui/SkeletonLoader';
import ProfileHeader from '../components/admin/clients/ProfileHeader';
import ClientDataCard from '../components/admin/clients/ClientDataCard';
import ClientHealthCards from '../components/admin/clients/ClientHealthCards';
import PaymentOverviewCard from '../components/admin/clients/PaymentOverviewCard';
import ClientContractsCard from '../components/admin/clients/ClientContractsCard';
import BookingHistorySection, { BookingNotesPatch } from '../components/admin/clients/BookingHistorySection';
import { ArrowLeft, NotebookPen, Check } from 'lucide-react';

export default function ClientProfilePage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [user, setUser] = useState<UserDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [notes, setNotes] = useState('');
    const [notesSaving, setNotesSaving] = useState(false);
    const [notesSaved, setNotesSaved] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Admin payment overview: auto-charge, saved cards, upcoming installments.
    const [payOverview, setPayOverview] = useState<Awaited<ReturnType<typeof usersApi.paymentOverview>> | null>(null);
    const [autoSaving, setAutoSaving] = useState(false);
    useEffect(() => { if (id) loadUser(); }, [id]);

    const handleAutoCharge = async (enabled: boolean) => {
        setAutoSaving(true);
        try {
            const r = await usersApi.setAutoCharge(id!, enabled);
            setPayOverview(p => (p ? { ...p, autoChargeEnabled: r.autoChargeEnabled } : p));
        } catch (err) { console.error(err); }
        finally { setAutoSaving(false); }
    };

    const loadUser = async () => {
        setLoading(true);
        try {
            const res = await usersApi.getById(id!);
            setUser(res.user);
            setNotes(res.user.notes || '');
            usersApi.paymentOverview(id!).then(setPayOverview).catch(() => setPayOverview(null));
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    };

    const handleNotesChange = (value: string) => {
        setNotes(value);
        setNotesSaved(false);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
            setNotesSaving(true);
            try {
                await usersApi.update(id!, { notes: value });
                setNotesSaved(true);
                setTimeout(() => setNotesSaved(false), 2000);
            } catch (err) { console.error(err); }
            finally { setNotesSaving(false); }
        }, 1000);
    };

    const handleBookingUpdated = (bookingId: string, patch: BookingNotesPatch) => {
        setUser(u => u ? { ...u, bookings: u.bookings.map(b => b.id === bookingId ? { ...b, ...patch } : b) } : u);
    };

    if (loading) return <div><HeroSkeleton /><TableSkeleton rows={4} cols={3} /></div>;
    if (!user) return <div className="card"><div className="empty-state"><div className="empty-state-text">Usuário não encontrado</div></div></div>;

    return (
        <div>
            <div style={{ marginBottom: '16px' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/clients')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><ArrowLeft size={15} aria-hidden="true" /> Voltar para Clientes</button>
            </div>

            <ProfileHeader user={user} />

            <ClientDataCard user={user} onSaved={loadUser} />

            <ClientHealthCards user={user} />

            {payOverview && (
                <PaymentOverviewCard overview={payOverview} autoSaving={autoSaving} onToggleAutoCharge={handleAutoCharge} />
            )}

            <ClientContractsCard contracts={user.contracts} />

            {/* Notes — Full Width */}
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
                    value={notes}
                    onChange={e => handleNotesChange(e.target.value)}
                />
            </div>

            <BookingHistorySection bookings={user.bookings} onBookingUpdated={handleBookingUpdated} />
        </div>
    );
}
