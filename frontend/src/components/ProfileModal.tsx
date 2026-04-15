import React, { useState, useRef } from 'react';
import ModalOverlay from './ModalOverlay';
import ImageCropper from './ImageCropper';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../api/client';

interface ProfileModalProps {
    onClose: () => void;
    onSuccess: (msg: string) => void;
}

export default function ProfileModal({ onClose, onSuccess }: ProfileModalProps) {
    const { user, updateUser } = useAuth();
    const [name, setName] = useState(user?.name || '');
    const [phone, setPhone] = useState(user?.phone || '');
    const [password, setPassword] = useState('');
    const [cpfCnpj, setCpfCnpj] = useState(user?.cpfCnpj || '');
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
    } catch (e) {}

    const [instagram, setInstagram] = useState(initialInsta);
    const [linkedin, setLinkedin] = useState(initialLink);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [uploadingPhoto, setUploadingPhoto] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);

    const handleSave = async () => {
        setSaving(true); setError('');
        try {
            const data: Record<string, string> = {};
            if (name && name !== user?.name) data.name = name;
            if (phone !== (user?.phone || '')) data.phone = phone;
            if (password) data.password = password;
            if (cpfCnpj !== (user?.cpfCnpj || '')) data.cpfCnpj = cpfCnpj;
            if (address !== (user?.address || '')) data.address = address;
            if (city !== (user?.city || '')) data.city = city;
            if (state !== (user?.state || '')) data.state = state;

            if (instagram !== initialInsta || linkedin !== initialLink) {
                data.socialLinks = JSON.stringify({ instagram, linkedin });
            }

            if (Object.keys(data).length > 0) {
                const res = await authApi.updateProfile(data);
                updateUser(res.user);
            }
            onSuccess('Perfil atualizado com sucesso!');
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Erro desconhecido');
            setSaving(false);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
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
            onSuccess('Foto de perfil atualizada!');
            onClose();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Erro desconhecido');
        } finally {
            setUploadingPhoto(false);
        }
    };

    const initials = user?.name
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

    return (
        <ModalOverlay onClose={onClose} preventClose={!!cropImageSrc}>
            <div className="modal" style={{ maxWidth: cropImageSrc ? 380 : 540, maxHeight: '90vh', overflowY: 'auto' }}>
                <h2 className="modal-title" style={{ textAlign: 'center', marginBottom: '20px' }}>
                    {cropImageSrc ? '✂️ Ajustar Foto' : 'Meu Perfil'}
                </h2>

                {cropImageSrc ? (
                    <ImageCropper
                        imageSrc={cropImageSrc}
                        onConfirm={handleCropConfirm}
                        onCancel={() => setCropImageSrc(null)}
                    />
                ) : (
                    <>
                        {/* Avatar */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '24px' }}>
                            <div
                                style={{
                                    width: 96, height: 96, borderRadius: '50%',
                                    background: user?.photoUrl
                                        ? `url(${user.photoUrl}) center/cover no-repeat`
                                        : 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    fontSize: '2rem', fontWeight: 700, color: '#fff',
                                    cursor: 'pointer', position: 'relative',
                                    border: '3px solid var(--border-color)',
                                    transition: 'transform 0.2s, box-shadow 0.2s',
                                }}
                                onClick={() => fileRef.current?.click()}
                                onMouseOver={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1.05)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)'; }}
                                onMouseOut={e => { (e.currentTarget as HTMLElement).style.transform = 'scale(1)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
                                title="Clique para trocar a foto"
                            >
                                {!user?.photoUrl && initials}
                                {uploadingPhoto && (
                                    <div style={{
                                        position: 'absolute', inset: 0, borderRadius: '50%',
                                        background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    }}>
                                        <div className="spinner" style={{ width: 24, height: 24 }} />
                                    </div>
                                )}
                            </div>
                            <input ref={fileRef} type="file" accept="image/*" onChange={handleFileSelect} style={{ display: 'none' }} />
                            <button
                                className="btn btn-ghost btn-sm"
                                style={{ marginTop: '8px', fontSize: '0.75rem' }}
                                onClick={() => fileRef.current?.click()}
                                disabled={uploadingPhoto}
                            >
                                📷 {uploadingPhoto ? 'Enviando...' : 'Alterar foto'}
                            </button>
                        </div>

                        {error && <div className="error-message" style={{ marginBottom: '12px' }}>{error}</div>}

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
                            <label className="form-label">Telefone</label>
                            <input className="form-input" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(21) 99999-9999" />
                        </div>

                        <div className="form-group">
                            <label className="form-label">Nova Senha (deixe vazio para manter)</label>
                            <input className="form-input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mínimo 6 caracteres" />
                        </div>

                        <div className="form-group">
                            <label className="form-label">CPF / CNPJ</label>
                            <input className="form-input" value={cpfCnpj} onChange={e => setCpfCnpj(e.target.value)} placeholder="000.000.000-00" />
                        </div>

                        <div className="form-group">
                            <label className="form-label">Endereço</label>
                            <input className="form-input" value={address} onChange={e => setAddress(e.target.value)} placeholder="Rua, Número, Complemento" />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px', marginBottom: '16px' }}>
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
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-secondary)', padding: '0 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                                <span style={{ color: 'var(--text-muted)' }}>@</span>
                                <input className="form-input" style={{ border: 'none', padding: '10px 0', background: 'transparent' }} value={instagram} onChange={e => setInstagram(e.target.value)} placeholder="usuario" />
                            </div>
                        </div>

                        <div className="form-group">
                            <label className="form-label">LinkedIn (URL)</label>
                            <input className="form-input" value={linkedin} onChange={e => setLinkedin(e.target.value)} placeholder="https://linkedin.com/in/..." />
                        </div>

                        <div className="modal-actions" style={{ marginTop: '16px' }}>
                            <button className="btn btn-secondary" onClick={onClose}>Fechar</button>
                            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                                {saving ? '⏳ Salvando...' : '💾 Salvar'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </ModalOverlay>
    );
}
