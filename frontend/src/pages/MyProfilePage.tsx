import { useState, useRef, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';
import { maskCpfCnpj, isValidCpfCnpj } from '../utils/mask';
import HeroAmbient from '../components/client/HeroAmbient';
import ImageCropper from '../components/ImageCropper';
import ToggleSwitch from '../components/ui/ToggleSwitch';
import AddressFields, { type AddressValues } from '../components/admin/clients/AddressFields';
import { ArrowLeft, UserRound, Camera, Save, Loader2, CheckCircle2 } from 'lucide-react';

export default function MyProfilePage() {
    const navigate = useNavigate();
    const { user, updateUser } = useAuth();

    const [name, setName] = useState(user?.name || '');
    const [phone, setPhone] = useState(user?.phone || '');
    const [password, setPassword] = useState('');
    const [cpfCnpj, setCpfCnpj] = useState(user?.cpfCnpj ? maskCpfCnpj(user.cpfCnpj) : '');
    const [addr, setAddr] = useState<AddressValues>({
        zipCode: user?.zipCode || '', address: user?.address || '', addressNumber: user?.addressNumber || '',
        complement: user?.complement || '', neighborhood: user?.neighborhood || '', city: user?.city || '', state: user?.state || '',
    });

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
            (['zipCode', 'address', 'addressNumber', 'complement', 'neighborhood', 'city', 'state'] as const).forEach(f => {
                if (addr[f] !== (user?.[f] || '')) data[f] = addr[f];
            });
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
                    <div className="client-hero__icon-wrapper client-hero__icon-wrapper--cyan">
                        <UserRound size={22} />
                    </div>
                    <div>
                        <h2 className="client-hero__greeting">Meu Perfil</h2>
                        <p className="client-hero__message">Gerencie seus dados e preferências</p>
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
                    <div className="profile-avatar-block">
                        <div
                            className="profile-avatar"
                            style={{
                                background: user?.photoUrl
                                    ? `url(${user.photoUrl}) center/cover no-repeat`
                                    : 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                            }}
                            onClick={() => fileRef.current?.click()}
                            title="Clique para trocar a foto"
                        >
                            {!user?.photoUrl && initials}
                            {uploadingPhoto && (
                                <div className="profile-avatar__overlay">
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
                        <AddressFields values={addr} onChange={patch => setAddr(a => ({ ...a, ...patch }))} />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Instagram</label>
                        <div className="profile-input-adorned">
                            <span className="profile-input-adorned__prefix">@</span>
                            <input className="form-input" value={instagram} onChange={e => setInstagram(e.target.value)} placeholder="usuario" />
                        </div>
                    </div>
                    <div className="form-group">
                        <label className="form-label">LinkedIn (URL)</label>
                        <input className="form-input" value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="https://linkedin.com/in/..." />
                    </div>
                    <div className="form-group">
                        <label className="form-label">Notificações</label>
                        <ToggleSwitch checked={essentialOnly} onChange={setEssentialOnly} label="Apenas notificações essenciais" disabled={saving} />
                        <div className="profile-hint">
                            Receba só avisos importantes (pagamentos e perda de crédito). Lembretes e dicas ficam silenciados.
                        </div>
                    </div>

                    <button className="btn btn-primary profile-save-btn" onClick={handleSave} disabled={saving}>
                        {saving ? <><Loader2 size={16} className="login-spinner" /> Salvando…</> : <><Save size={16} /> Salvar perfil</>}
                    </button>
                </div>
            )}
        </div>
    );
}
