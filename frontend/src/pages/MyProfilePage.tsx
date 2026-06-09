import { useState, useRef, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';
import { maskCpfCnpj, isValidCpfCnpj } from '../utils/mask';
import HeroAmbient from '../components/client/HeroAmbient';
import ImageCropper from '../components/ImageCropper';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import { ArrowLeft, UserRound, Camera, Save, Loader2, CheckCircle2 } from 'lucide-react';

export default function MyProfilePage() {
    const navigate = useNavigate();
    const { user, updateUser } = useAuth();

    const [name, setName] = useState(user?.name || '');
    const [phone, setPhone] = useState(user?.phone || '');
    const [password, setPassword] = useState('');
    const [cpfCnpj, setCpfCnpj] = useState(user?.cpfCnpj ? maskCpfCnpj(user.cpfCnpj) : '');
    const [address, setAddress] = useState(user?.address || '');
    const [city, setCity] = useState(user?.city || '');
    const [state, setState] = useState(user?.state || '');

    let initialInsta = '';
    let initialLink = '';
    try {
        if (user?.socialLinks) {
            const parsed = typeof user.socialLinks === 'string' ? JSON.parse(user.socialLinks) : user.socialLinks;
            initialInsta = parsed.instagram || '';
            initialLink = parsed.linkedin || '';
        }
    } catch { /* ignore malformed socialLinks */ }

    const [instagram, setInstagram] = useState(initialInsta);
    const [linkedin, setLinkedin] = useState(initialLink);
    const [essentialOnly, setEssentialOnly] = useState(user?.essentialNotificationsOnly ?? false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [uploadingPhoto, setUploadingPhoto] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);

    const flashSuccess = (msg: string) => {
        setSuccess(msg);
        setTimeout(() => setSuccess(''), 4000);
    };

    const handleSave = async () => {
        setSaving(true); setError(''); setSuccess('');
        try {
            const data: Parameters<typeof authApi.updateProfile>[0] = {};
            if (name && name !== user?.name) data.name = name;
            if (phone !== (user?.phone || '')) data.phone = phone;
            if (password) data.password = password;
            const cpfDigits = cpfCnpj.replace(/\D/g, '');
            if (cpfDigits !== (user?.cpfCnpj || '').replace(/\D/g, '')) {
                if (cpfDigits && !isValidCpfCnpj(cpfDigits)) {
                    setError('CPF/CNPJ inválido. Confira os números.');
                    setSaving(false);
                    return;
                }
                data.cpfCnpj = cpfDigits;
            }
            if (address !== (user?.address || '')) data.address = address;
            if (city !== (user?.city || '')) data.city = city;
            if (state !== (user?.state || '')) data.state = state;
            if (instagram !== initialInsta || linkedin !== initialLink) {
                data.socialLinks = JSON.stringify({ instagram, linkedin });
            }
            if (essentialOnly !== (user?.essentialNotificationsOnly ?? false)) {
                data.essentialNotificationsOnly = essentialOnly;
            }

            if (Object.keys(data).length > 0) {
                const res = await authApi.updateProfile(data);
                updateUser(res.user);
            }
            setPassword('');
            flashSuccess('Perfil atualizado com sucesso!');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Erro ao salvar o perfil.');
        } finally {
            setSaving(false);
        }
    };

    const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => setCropImageSrc(reader.result as string);
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const handleCropConfirm = async (blob: Blob) => {
        setCropImageSrc(null);
        setUploadingPhoto(true); setError('');
        try {
            const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
            const res = await authApi.uploadPhoto(file);
            updateUser(res.user);
            flashSuccess('Foto de perfil atualizada!');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Erro ao enviar a foto.');
        } finally {
            setUploadingPhoto(false);
        }
    };

    const initials = (user?.name || '')
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

    return (
        <div>
            {/* Hero */}
            <div className="client-hero client-hero--default animate-card-enter">
                <HeroAmbient variant="inicio" />
                <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)} style={{ marginBottom: 12, gap: 6 }}>
                    <ArrowLeft size={16} /> Voltar
                </button>
                <div className="client-hero__header" style={{ marginBottom: 0 }}>
                    <div className="client-hero__icon-wrapper" style={{
                        background: 'linear-gradient(135deg, rgba(17,129,155,0.22), rgba(17,129,155,0.05))',
                        borderColor: 'rgba(17,129,155,0.25)', boxShadow: '0 0 20px rgba(17,129,155,0.12)', color: '#33c4e0',
                    }}>
                        <UserRound size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting" style={{ margin: 0 }}>Meu Perfil</h2>
                        <p className="client-hero__message" style={{ margin: '4px 0 0 0' }}>Gerencie seus dados e preferências</p>
                    </div>
                </div>
            </div>

            {cropImageSrc ? (
                <div className="profile-page-section animate-card-enter">
                    <ImageCropper imageSrc={cropImageSrc} onConfirm={handleCropConfirm} onCancel={() => setCropImageSrc(null)} />
                </div>
            ) : (
                <div className="profile-page-section animate-card-enter">
                    {/* Avatar */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
                        <div
                            style={{
                                width: 104, height: 104, borderRadius: '50%',
                                background: user?.photoUrl
                                    ? `url(${user.photoUrl}) center/cover no-repeat`
                                    : 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: '2.1rem', fontWeight: 700, color: '#fff',
                                cursor: 'pointer', position: 'relative', border: '3px solid var(--border-color)',
                            }}
                            onClick={() => fileRef.current?.click()}
                            title="Clique para trocar a foto"
                        >
                            {!user?.photoUrl && initials}
                            {uploadingPhoto && (
                                <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <div className="spinner" style={{ width: 24, height: 24 }} />
                                </div>
                            )}
                        </div>
                        <input ref={fileRef} type="file" accept="image/*" onChange={handleFileSelect} style={{ display: 'none' }} />
                        <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, gap: 6 }} onClick={() => fileRef.current?.click()} disabled={uploadingPhoto}>
                            <Camera size={15} /> {uploadingPhoto ? 'Enviando…' : 'Alterar foto'}
                        </button>
                    </div>

                    {error && <div className="error-message" style={{ marginBottom: 12 }}>{error}</div>}
                    {success && (
                        <div className="login-modal-alert login-modal-alert--success" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <CheckCircle2 size={16} /> {success}
                        </div>
                    )}

                    {/* Form */}
                    <div className="form-group">
                        <label className="form-label">E-mail</label>
                        <input className="form-input" value={user?.email || ''} disabled style={{ opacity: 0.6 }} />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Nome</label>
                        <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Seu nome" />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Telefone (contato)</label>
                        <input className="form-input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(21) 99999-9999" />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Nova senha (deixe vazio para manter)</label>
                        <input className="form-input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo 6 caracteres" autoComplete="new-password" />
                    </div>
                    <div className="form-group">
                        <label className="form-label">CPF / CNPJ</label>
                        <input className="form-input" value={cpfCnpj} onChange={e => setCpfCnpj(maskCpfCnpj(e.target.value))} inputMode="numeric" placeholder="000.000.000-00" />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Endereço</label>
                        <input className="form-input" value={address} onChange={e => setAddress(e.target.value)} placeholder="Rua, Número, Complemento" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, marginBottom: 16 }}>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">Cidade</label>
                            <input className="form-input" value={city} onChange={e => setCity(e.target.value)} placeholder="Cidade" />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                            <label className="form-label">UF</label>
                            <input className="form-input" value={state} onChange={e => setState(e.target.value)} placeholder="UF" maxLength={2} />
                        </div>
                    </div>
                    <div className="form-group">
                        <label className="form-label">Instagram</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', padding: '0 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                            <span style={{ color: 'var(--text-muted)' }}>@</span>
                            <input className="form-input" style={{ border: 'none', padding: '10px 0', background: 'transparent' }} value={instagram} onChange={e => setInstagram(e.target.value)} placeholder="usuario" />
                        </div>
                    </div>
                    <div className="form-group">
                        <label className="form-label">LinkedIn (URL)</label>
                        <input className="form-input" value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="https://linkedin.com/in/..." />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Notificações</label>
                        <ToggleSwitch checked={essentialOnly} onChange={setEssentialOnly} label="Apenas notificações essenciais" disabled={saving} />
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
                            Receba só avisos importantes (pagamentos e perda de crédito). Lembretes e dicas ficam silenciados.
                        </div>
                    </div>

                    <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ width: '100%', marginTop: 8, gap: 8 }}>
                        {saving ? <><Loader2 size={16} className="login-spinner" /> Salvando…</> : <><Save size={16} /> Salvar perfil</>}
                    </button>
                </div>
            )}
        </div>
    );
}
