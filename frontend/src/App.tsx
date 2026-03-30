import React, { useState, useRef, useEffect, useCallback } from 'react';
import ModalOverlay from './components/ModalOverlay';
import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UIProvider, useUI } from './context/UIContext';
import { authApi } from './api/client';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CalendarPage from './pages/CalendarPage';
import MyBookingsPage from './pages/MyBookingsPage';
import MyContractsPage from './pages/MyContractsPage';
import AdminClientsPage from './pages/AdminClientsPage';
import AdminBookingsPage from './pages/AdminBookingsPage';
import AdminContractsPage from './pages/AdminContractsPage';
import AdminPricingPage from './pages/AdminPricingPage';
import AdminTodayPage from './pages/AdminTodayPage';
import AdminFinancePage from './pages/AdminFinancePage';
import AdminReportsPage from './pages/AdminReportsPage';
import NotificationBell from './components/NotificationBell';
import ClientProfilePage from './pages/ClientProfilePage';
import LandingPage from './pages/LandingPage';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { loadPaymentMethods } from './constants/paymentMethods';

// ─── Image Cropper ──────────────────────────────────────

function ImageCropper({ imageSrc, onConfirm, onCancel }: {
    imageSrc: string;
    onConfirm: (blob: Blob) => void;
    onCancel: () => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

    const SIZE = 256;

    useEffect(() => {
        const image = new Image();
        image.onload = () => {
            setImg(image);
            // Auto-fit: scale so shortest side fills the area
            const scale = SIZE / Math.min(image.width, image.height);
            setZoom(scale);
            setOffset({ x: 0, y: 0 });
        };
        image.src = imageSrc;
    }, [imageSrc]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !img) return;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, SIZE, SIZE);

        const w = img.width * zoom;
        const h = img.height * zoom;
        const x = (SIZE - w) / 2 + offset.x;
        const y = (SIZE - h) / 2 + offset.y;

        // Clip to circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(img, x, y, w, h);
        ctx.restore();

        // Draw circle border
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
        ctx.stroke();
    }, [img, zoom, offset]);

    useEffect(() => { draw(); }, [draw]);

    const handleMouseDown = (e: React.MouseEvent) => {
        setDragging(true);
        dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (!dragging) return;
        setOffset({
            x: dragStart.current.ox + (e.clientX - dragStart.current.x),
            y: dragStart.current.oy + (e.clientY - dragStart.current.y),
        });
    };

    const handleMouseUp = () => setDragging(false);

    const handleTouchStart = (e: React.TouchEvent) => {
        const t = e.touches[0];
        setDragging(true);
        dragStart.current = { x: t.clientX, y: t.clientY, ox: offset.x, oy: offset.y };
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (!dragging) return;
        const t = e.touches[0];
        setOffset({
            x: dragStart.current.ox + (t.clientX - dragStart.current.x),
            y: dragStart.current.oy + (t.clientY - dragStart.current.y),
        });
    };

    const handleConfirm = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Redraw final version (full quality, no border)
        if (img) {
            const ctx = canvas.getContext('2d')!;
            ctx.clearRect(0, 0, SIZE, SIZE);
            const w = img.width * zoom;
            const h = img.height * zoom;
            const x = (SIZE - w) / 2 + offset.x;
            const y = (SIZE - h) / 2 + offset.y;
            ctx.drawImage(img, x, y, w, h);
        }
        canvas.toBlob((blob) => {
            if (blob) onConfirm(blob);
        }, 'image/jpeg', 0.9);
    };

    const minZoom = img ? SIZE / Math.max(img.width, img.height) * 0.5 : 0.1;
    const maxZoom = img ? SIZE / Math.min(img.width, img.height) * 3 : 5;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                Arraste para posicionar · Use o slider para zoom
            </div>

            <div style={{
                position: 'relative', width: SIZE, height: SIZE,
                borderRadius: '50%', overflow: 'hidden',
                cursor: dragging ? 'grabbing' : 'grab',
                border: '3px solid var(--accent-primary)',
                boxShadow: '0 0 30px rgba(var(--accent-primary-rgb, 99,102,241), 0.3)',
            }}>
                <canvas
                    ref={canvasRef}
                    width={SIZE}
                    height={SIZE}
                    style={{ display: 'block' }}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onTouchStart={handleTouchStart}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleMouseUp}
                />
            </div>

            {/* Zoom slider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', maxWidth: 280 }}>
                <span style={{ fontSize: '0.75rem' }}>🔍−</span>
                <input
                    type="range"
                    min={minZoom}
                    max={maxZoom}
                    step={0.01}
                    value={zoom}
                    onChange={e => setZoom(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent-primary)' }}
                />
                <span style={{ fontSize: '0.75rem' }}>🔍+</span>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancelar</button>
                <button className="btn btn-primary btn-sm" onClick={handleConfirm}>✅ Usar esta foto</button>
            </div>
        </div>
    );
}

// ─── Success Toast ──────────────────────────────────────

function SuccessToast({ message, onDone }: { message: string; onDone: () => void }) {
    useEffect(() => {
        const timer = setTimeout(onDone, 3000);
        return () => clearTimeout(timer);
    }, [onDone]);

    return (
        <div style={{
            position: 'fixed', top: 24, right: 24, zIndex: 9999,
            padding: '12px 20px', borderRadius: 'var(--radius-md)',
            background: 'var(--tier-comercial)', color: '#fff',
            fontWeight: 600, fontSize: '0.875rem',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            animation: 'slideIn 0.3s ease-out',
            display: 'flex', alignItems: 'center', gap: '8px',
        }}>
            ✅ {message}
        </div>
    );
}

// ─── Profile Modal ──────────────────────────────────────

function ProfileModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: (msg: string) => void }) {
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

    // Crop state
    const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);

    const handleSave = async () => {
        setSaving(true); setError('');
        try {
            const data: any = {};
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
        } catch (err: any) { setError(err.message); setSaving(false); }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // Read file as data URL for the cropper
        const reader = new FileReader();
        reader.onload = () => setCropImageSrc(reader.result as string);
        reader.readAsDataURL(file);
        // Reset input so same file can be re-selected
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
        } catch (err: any) { setError(err.message); }
        finally { setUploadingPhoto(false); }
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

                {/* Crop Mode */}
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

// ─── Layout ─────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
    const { user, logout } = useAuth();
    const [showProfile, setShowProfile] = useState(false);
    const [toast, setToast] = useState('');

    const isAdmin = user?.role === 'ADMIN';
    const initials = user?.name
        .split(' ')
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

    return (
        <div className="app-layout">
            <aside className="sidebar">
                <div className="sidebar-logo" style={{ padding: '0 20px 20px', background: 'none', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: '16px' }}>
                    <img
                        src="https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg"
                        alt="Búzios Digital"
                        style={{ height: '30px', marginBottom: '6px' }}
                    />
                    <span style={{ fontSize: '0.5625rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700 }}>Estúdio de Podcast</span>
                </div>

                <nav className="sidebar-nav">
                    <NavLink to="/dashboard" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                        <span className="icon">📊</span>
                        <span>Dashboard</span>
                    </NavLink>

                    <NavLink to="/calendar" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                        <span className="icon">📅</span>
                        <span>Agenda</span>
                    </NavLink>

                    {!isAdmin && (
                        <>
                            <NavLink to="/my-bookings" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">🎬</span>
                                <span>Minhas Gravações</span>
                            </NavLink>

                            <NavLink to="/my-contracts" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">📋</span>
                                <span>Meus Contratos</span>
                            </NavLink>
                        </>
                    )}

                    {isAdmin && (
                        <>
                            <div style={{ padding: '14px 12px 6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div style={{ height: 1, flex: 1, background: 'rgba(255,255,255,0.06)' }} />
                                <span style={{ fontSize: '0.5625rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', fontWeight: 700, whiteSpace: 'nowrap' }}>Administração</span>
                                <div style={{ height: 1, flex: 1, background: 'rgba(255,255,255,0.06)' }} />
                            </div>

                            <NavLink to="/admin/today" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">📍</span>
                                <span>Hoje</span>
                            </NavLink>

                            <NavLink to="/admin/bookings" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">📋</span>
                                <span>Agendamentos</span>
                            </NavLink>

                            <NavLink to="/admin/clients" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">👥</span>
                                <span>Clientes</span>
                            </NavLink>

                            <NavLink to="/admin/contracts" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">📄</span>
                                <span>Contratos</span>
                            </NavLink>

                            <NavLink to="/admin/pricing" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">💰</span>
                                <span>Planos & Valores</span>
                            </NavLink>

                            <NavLink to="/admin/finance" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">💳</span>
                                <span>Financeiro</span>
                            </NavLink>

                            <NavLink to="/admin/reports" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                                <span className="icon">📈</span>
                                <span>Relatórios</span>
                            </NavLink>
                        </>
                    )}
                </nav>

                <div className="sidebar-footer">
                    <div style={{ padding: '0 12px 8px' }}>
                        <NotificationBell />
                    </div>
                    <div className="sidebar-user" style={{ cursor: 'pointer' }} onClick={() => setShowProfile(true)} title="Clique para editar perfil">
                        <div
                            className="sidebar-user-avatar"
                            style={user?.photoUrl ? {
                                backgroundImage: `url(${user.photoUrl})`,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                                fontSize: 0,
                            } : {}}
                        >
                            {!user?.photoUrl && initials}
                        </div>
                        <div className="sidebar-user-info">
                            <div className="sidebar-user-name">{user?.name}</div>
                            <div className="sidebar-user-role">
                                {user?.role === 'ADMIN' ? 'Administrador' : 'Cliente'}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={logout}
                        style={{
                            width: '100%', marginTop: '8px', padding: '7px 12px', borderRadius: '8px',
                            background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.15)',
                            color: '#ef4444', fontSize: '0.75rem', fontWeight: 600,
                            cursor: 'pointer', transition: 'all 0.2s', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', gap: '6px', fontFamily: 'inherit',
                        }}
                    >
                        🚪 Sair
                    </button>
                </div>
            </aside>

            <main className="main-content">
                {children}
            </main>

            {showProfile && (
                <ProfileModal
                    onClose={() => setShowProfile(false)}
                    onSuccess={(msg) => { setShowProfile(false); setToast(msg); }}
                />
            )}

            {toast && <SuccessToast message={toast} onDone={() => setToast('')} />}
        </div>
    );
}

// ─── Route Guards ───────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const { user, loading } = useAuth();

    if (loading) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    if (!user) {
        return <Navigate to="/login" replace />;
    }

    return <Layout>{children}</Layout>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
    const { user } = useAuth();
    if (user?.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;
    return <>{children}</>;
}

function AppRoutes() {
    const { user, loading } = useAuth();

    // Load payment methods from API on app init
    useEffect(() => {
        if (user) { loadPaymentMethods(); }
    }, [user]);

    if (loading) {
        return (
            <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div className="spinner" />
            </div>
        );
    }

    return (
        <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
            <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
            <Route path="/my-bookings" element={<ProtectedRoute><MyBookingsPage /></ProtectedRoute>} />
            <Route path="/my-contracts" element={<ProtectedRoute><MyContractsPage /></ProtectedRoute>} />

            {/* Admin routes */}
            <Route path="/admin/today" element={<ProtectedRoute><AdminRoute><AdminTodayPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/bookings" element={<ProtectedRoute><AdminRoute><AdminBookingsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/clients" element={<ProtectedRoute><AdminRoute><AdminClientsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/clients/:id" element={<ProtectedRoute><AdminRoute><ClientProfilePage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/contracts" element={<ProtectedRoute><AdminRoute><AdminContractsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/pricing" element={<ProtectedRoute><AdminRoute><AdminPricingPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/finance" element={<ProtectedRoute><AdminRoute><AdminFinancePage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/reports" element={<ProtectedRoute><AdminRoute><AdminReportsPage /></AdminRoute></ProtectedRoute>} />

            {/* Legacy redirects */}
            <Route path="/clients" element={<Navigate to="/admin/clients" replace />} />

            <Route path="*" element={<Navigate to={user ? '/dashboard' : '/login'} replace />} />
        </Routes>
    );
}

export default function App() {
    const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || "mock-client-id";
    return (
        <GoogleOAuthProvider clientId={clientId}>
            <UIProvider>
                <BrowserRouter>
                    <AuthProvider>
                        <AppRoutes />
                    </AuthProvider>
                </BrowserRouter>
            </UIProvider>
        </GoogleOAuthProvider>
    );
}
