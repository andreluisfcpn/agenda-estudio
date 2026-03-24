import React, { useState, FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { maskPhone, maskEmail, translateError } from '../utils/mask';
import { ApiError } from '../api/client';
import { useGoogleLogin } from '@react-oauth/google';

interface LoginModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
    const navigate = useNavigate();
    const { login, register, googleLogin, sendRegistrationCode } = useAuth();

    const [view, setView] = useState<'login' | 'register_form' | 'register_method' | 'register_code'>('login');
    const isRegister = view !== 'login';
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [error, setError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [selectedMethod, setSelectedMethod] = useState<'email' | 'phone' | null>(null);
    const [code, setCode] = useState('');

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setFieldErrors({});
        setLoading(true);
        try {
            if (view === 'register_form') {
                const errors: Record<string, string> = {};
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

                if (!name) errors.name = 'Nome é obrigatório';
                if (!email) errors.email = 'E-mail é obrigatório';
                else if (!emailRegex.test(email)) errors.email = 'E-mail inválido';

                if (!phone) errors.phone = 'Telefone é obrigatório';
                if (!password) errors.password = 'Senha é obrigatória';
                else if (password.length < 6) errors.password = 'Senha deve ter no mínimo 6 caracteres';

                if (Object.keys(errors).length > 0) {
                    setFieldErrors(errors);
                    setError('Por favor, corrija os erros abaixo.');
                    setLoading(false);
                    return;
                }

                setView('register_method');
                setLoading(false);
                return;
            }

            if (view === 'register_code' && selectedMethod) {
                await register({ email, password, name, phone: phone.replace(/\D/g, ''), code, method: selectedMethod });
                onClose();
                const pending = sessionStorage.getItem('pendingBooking');
                if (pending) {
                    const { date, time } = JSON.parse(pending);
                    sessionStorage.removeItem('pendingBooking');
                    navigate('/calendar', { state: { preSelectedDate: date, preSelectedTime: time } });
                } else {
                    navigate('/calendar');
                }
                return;
            }

            if (view === 'login') {
                await login(email, password);
                onClose();
                const pending = sessionStorage.getItem('pendingBooking');
                if (pending) {
                    const { date, time } = JSON.parse(pending);
                    sessionStorage.removeItem('pendingBooking');
                    navigate('/calendar', { state: { preSelectedDate: date, preSelectedTime: time } });
                } else {
                    navigate('/calendar');
                }
            }
        } catch (err: any) {
            if (err instanceof ApiError) {
                let mainError = err.message || 'Erro ao processar solicitação';
                if (err.details && Array.isArray(err.details)) {
                    const mapped: Record<string, string> = {};
                    err.details.forEach((issue: any) => {
                        const key = issue.path.join('.');
                        mapped[key] = issue.message;
                        if (mainError === 'Dados inválidos.' || mainError === 'Bad Request') {
                            mainError = issue.message;
                        }
                    });
                    setFieldErrors(mapped);
                } else {
                    setFieldErrors(err.details || {});
                }
                setError(mainError);
            } else {
                setError('Erro de conexão com o servidor. Tente novamente.');
            }
        } finally {
            setLoading(false);
        }
    };


    const handleSelectMethod = async (method: 'email' | 'phone') => {
        setSelectedMethod(method);
        setError('');
        setFieldErrors({});
        setLoading(true);
        try {
            await sendRegistrationCode({ email, password, name, phone: phone.replace(/\D/g, ''), method });
            setView('register_code');
        } catch (err: any) {
            if (err instanceof ApiError) {
                let mainError = err.message || 'Erro ao processar solicitação';
                if (err.details && Array.isArray(err.details)) {
                    const mapped: Record<string, string> = {};
                    err.details.forEach((issue: any) => {
                        const key = issue.path.join('.');
                        mapped[key] = issue.message;
                        if (mainError === 'Dados inválidos.' || mainError === 'Bad Request') {
                            mainError = issue.message;
                        }
                    });
                    setFieldErrors(mapped);
                } else {
                    setFieldErrors(err.details || {});
                }
                setError(mainError);
            } else {
                setError(err.message || 'Falha ao enviar código.');
            }
            // Return to form if there are field-specific errors
            setView('register_form');
        } finally {
            setLoading(false);
        }
    };

    const handleGoogleLogin = useGoogleLogin({
        onSuccess: async (tokenResponse) => {
            setError('');
            setLoading(true);
            try {
                await googleLogin(tokenResponse.access_token);
                onClose();
                const pending = sessionStorage.getItem('pendingBooking');
                if (pending) {
                    const { date, time } = JSON.parse(pending);
                    sessionStorage.removeItem('pendingBooking');
                    navigate('/calendar', { state: { preSelectedDate: date, preSelectedTime: time } });
                } else {
                    navigate('/calendar');
                }
            } catch (err: any) {
                setError(err.message || 'Falha na autenticação via Google');
            } finally {
                setLoading(false);
            }
        },
        onError: () => setError('Falha no login com Google')
    });


    if (!isOpen) return null;

    return (
        <div
            className="modal-overlay"
            onClick={e => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 26, 31, 0.85)',
                backdropFilter: 'blur(8px)',
            }}
        >
            <AnimatePresence>
                <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: 20 }}
                    style={{
                        background: '#091E24',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '24px',
                        width: '100%',
                        maxWidth: '440px',
                        padding: '36px',
                        boxShadow: '0 24px 48px rgba(0,0,0,0.4)',
                        position: 'relative'
                    }}
                >
                    <button
                        onClick={onClose}
                        style={{
                            position: 'absolute', top: '24px', right: '24px',
                            background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)',
                            cursor: 'pointer'
                        }}
                    >
                        <X size={24} />
                    </button>

                    <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                        <img
                            src="https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg"
                            alt="Búzios Digital"
                            style={{ height: '32px', marginBottom: '20px' }}
                        />
                        <h2 style={{ fontSize: '1.4rem', fontWeight: 800, margin: 0, lineHeight: 1.3, color: '#fff' }}>
                            {view === 'login' && 'Acesse seu painel'}
                            {view === 'register_form' && 'Crie sua conta'}
                            {view === 'register_method' && 'Confirme sua conta'}
                            {view === 'register_code' && 'Código de Verificação'}
                        </h2>
                        <p style={{ color: 'rgba(255,255,255,0.6)', margin: '8px 0 0 0', fontSize: '0.95rem' }}>
                            {view === 'login' && 'Gerencie seus agendamentos.'}
                            {view === 'register_form' && 'Rápido e seguro.'}
                            {view === 'register_method' && 'Como deseja receber seu código?'}
                            {view === 'register_code' && `Enviado para seu ${selectedMethod === 'email' ? 'e-mail' : 'telefone'}.`}
                        </p>
                    </div>

                    {error && (
                        <div style={{
                            background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)',
                            color: '#ef4444', padding: '12px 16px', borderRadius: '12px', fontSize: '0.9rem', marginBottom: '20px'
                        }}>
                            {translateError(error)}
                        </div>
                    )}


                    <form onSubmit={handleSubmit} noValidate>
                        {(view === 'login' || view === 'register_form') && (
                            <>
                                {view === 'register_form' && (
                                    <>
                                        <div style={{ marginBottom: '16px' }}>
                                            <label style={labelStyle}>Nome</label>
                                            <input
                                                type="text"
                                                placeholder="Seu nome artístico"
                                                value={name}
                                                onChange={e => setName(e.target.value)}
                                                style={{ ...inputStyle, borderColor: fieldErrors.name ? '#ef4444' : 'rgba(255,255,255,0.1)' }}
                                                required
                                            />
                                            {fieldErrors.name && <div style={errorTextStyle}>{translateError(fieldErrors.name)}</div>}
                                        </div>
                                        <div style={{ marginBottom: '16px' }}>
                                            <label style={labelStyle}>Telefone <span style={{ color: '#ff4444' }}>*</span></label>
                                            <input
                                                type="tel"
                                                placeholder="(21) 99999-0000"
                                                value={phone}
                                                onChange={e => setPhone(maskPhone(e.target.value))}
                                                style={{ ...inputStyle, borderColor: fieldErrors.phone ? '#ef4444' : 'rgba(255,255,255,0.1)' }}
                                                required
                                            />
                                            {fieldErrors.phone && <div style={errorTextStyle}>{translateError(fieldErrors.phone)}</div>}
                                        </div>
                                    </>
                                )}

                                <div style={{ marginBottom: '16px' }}>
                                    <label style={labelStyle}>E-mail</label>
                                    <input
                                        type="email"
                                        placeholder="seu@email.com"
                                        value={email}
                                        onChange={e => setEmail(maskEmail(e.target.value))}
                                        style={{ ...inputStyle, borderColor: fieldErrors.email ? '#ef4444' : 'rgba(255,255,255,0.1)' }}
                                        required
                                    />
                                    {fieldErrors.email && <div style={errorTextStyle}>{translateError(fieldErrors.email)}</div>}
                                </div>

                                <div style={{ marginBottom: '24px' }}>
                                    <label style={labelStyle}>Senha</label>
                                    <input
                                        type="password"
                                        placeholder="••••••"
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        style={{ ...inputStyle, borderColor: fieldErrors.password ? '#ef4444' : 'rgba(255,255,255,0.1)' }}
                                        minLength={6}
                                        required
                                    />
                                    {fieldErrors.password && <div style={errorTextStyle}>{translateError(fieldErrors.password)}</div>}
                                </div>

                                <button type="submit" disabled={loading} style={primaryBtnStyle}>
                                    {loading ? <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> : (view === 'register_form' ? 'Continuar' : 'Entrar')}
                                </button>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '20px 0', opacity: 0.4 }}>
                                    <div style={{ flex: 1, height: '1px', background: '#fff' }} />
                                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fff' }}>OU</span>
                                    <div style={{ flex: 1, height: '1px', background: '#fff' }} />
                                </div>
                            </>
                        )}

                        {view === 'register_method' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
                                <button type="button" onClick={() => handleSelectMethod('email')} disabled={loading} style={{ ...secondaryBtnStyle, border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }}>
                                    E-mail ({email})
                                </button>
                                <button type="button" onClick={() => handleSelectMethod('phone')} disabled={loading} style={{ ...secondaryBtnStyle, border: '1px solid rgba(255,255,255,0.2)', color: '#fff' }}>
                                    WhatsApp / SMS ({phone})
                                </button>
                            </div>
                        )}

                        {view === 'register_code' && (
                            <>
                                <div style={{ marginBottom: '24px' }}>
                                    <label style={labelStyle}>Código de 6 dígitos</label>
                                    <input
                                        type="text"
                                        placeholder="000000"
                                        value={code}
                                        onChange={e => setCode(e.target.value.replace(/\D/g, '').substring(0, 6))}
                                        style={{ ...inputStyle, borderColor: fieldErrors.code ? '#ef4444' : 'rgba(255,255,255,0.1)', textAlign: 'center', letterSpacing: '4px', fontSize: '1.5rem', fontWeight: 700 }}
                                        required
                                    />
                                    {fieldErrors.code && <div style={errorTextStyle}>{translateError(fieldErrors.code)}</div>}
                                </div>
                                <button type="submit" disabled={loading || code.length !== 6} style={primaryBtnStyle}>
                                    {loading ? <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} /> : 'Confirmar Código'}
                                </button>
                            </>
                        )}


                        {(view === 'login' || view === 'register_form') && (
                            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                                <button
                                    type="button"
                                    onClick={() => handleGoogleLogin()}
                                    style={{
                                        width: '100%',
                                        padding: '12px 16px',
                                        borderRadius: '24px',
                                        background: '#fff',
                                        color: '#3c4043',
                                        border: '1px solid #dadce0',
                                        fontWeight: 500,
                                        fontSize: '0.9rem',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '10px',
                                        cursor: 'pointer',
                                        fontFamily: '"Google Sans", arial, sans-serif'
                                    }}
                                >
                                    <svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                                        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.7 17.74 9.5 24 9.5z" />
                                        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                                        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                                        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                                        <path fill="none" d="M0 0h48v48H0z" />
                                    </svg>
                                    {view === 'register_form' ? 'Cadastrar-se com o Google' : 'Entrar com o Google'}
                                </button>
                            </div>
                        )}
                    </form>

                    {(view === 'login' || view === 'register_form') && (
                        <button
                            onClick={() => { setView(view === 'login' ? 'register_form' : 'login'); setError(''); setFieldErrors({}); }}
                            style={secondaryBtnStyle}
                        >
                            {view === 'register_form' ? 'Já tem conta? Faça login' : 'Novo aqui? Crie sua conta'}
                        </button>
                    )}

                    {(view === 'register_method' || view === 'register_code') && (
                        <button
                            onClick={() => { setView('register_form'); setError(''); setFieldErrors({}); setCode(''); }}
                            style={secondaryBtnStyle}
                        >
                            Voltar e editar dados
                        </button>
                    )}

                    <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(0,0,0,0.2)', borderRadius: '16px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', textAlign: 'left' }}>
                        <strong style={{ color: 'rgba(255,255,255,0.7)', display: 'block', marginBottom: '8px' }}>🧪 Login Rápido (Contas de Teste):</strong>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <button type="button" style={mockBtnStyle} onClick={() => { setEmail('admin@studio.com'); setPassword('admin123'); }}>🛡️ Admin [admin@studio.com] (admin123)</button>
                            <button type="button" style={mockBtnStyle} onClick={() => { setEmail('cliente@teste.com'); setPassword('cliente123'); }}>👤 Cliente Principal [cliente@teste.com] (cliente123)</button>
                        </div>
                    </div>
                </motion.div>
            </AnimatePresence>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: '8px', textAlign: 'left'
};

const inputStyle: React.CSSProperties = {
    width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '14px', padding: '14px 16px', color: '#fff', fontSize: '1rem',
    outline: 'none', transition: 'border-color 0.2s', fontFamily: 'inherit'
};

const primaryBtnStyle: React.CSSProperties = {
    width: '100%', padding: '16px', borderRadius: '14px', background: '#006C89', color: '#fff',
    border: 'none', fontWeight: 700, fontSize: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', transition: 'background 0.2s'
};

const secondaryBtnStyle: React.CSSProperties = {
    width: '100%', padding: '16px', borderRadius: '14px', background: 'transparent',
    border: 'none', color: 'rgba(255,255,255,0.5)', fontWeight: 600, fontSize: '0.9rem',
    cursor: 'pointer', transition: 'color 0.2s',
};

const mockBtnStyle: React.CSSProperties = {
    background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)',
    textAlign: 'left', fontSize: '0.75rem', cursor: 'pointer', padding: '4px',
    transition: 'color 0.2s'
};

const errorTextStyle: React.CSSProperties = {
    color: '#ef4444',
    fontSize: '0.75rem',
    marginTop: '6px',
    textAlign: 'left',
    fontWeight: 500
};
