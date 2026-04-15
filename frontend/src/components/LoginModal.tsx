import { getErrorMessage } from '../utils/errors';
import React, { useState, useEffect, useRef, FormEvent } from 'react';
import ModalOverlay from './ModalOverlay';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, ShieldCheck, User, ChevronLeft, Eye, EyeOff, Mail, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { maskPhone, maskEmail, translateError } from '../utils/mask';
import { ApiError } from '../api/client';
import { useGoogleLogin } from '@react-oauth/google';

interface LoginModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type ViewType = 'login' | 'register_form' | 'register_method' | 'register_code';

const VIEW_STEPS: Record<ViewType, number> = {
    login: 0,
    register_form: 1,
    register_method: 2,
    register_code: 3,
};

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
    const navigate = useNavigate();
    const { login, register, googleLogin, sendRegistrationCode } = useAuth();
    const firstInputRef = useRef<HTMLInputElement>(null);

    const [view, setView] = useState<ViewType>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [error, setError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [selectedMethod, setSelectedMethod] = useState<'email' | 'phone' | null>(null);
    const [code, setCode] = useState('');

    // Focus first input when modal opens or view changes
    useEffect(() => {
        if (isOpen) {
            const timer = setTimeout(() => firstInputRef.current?.focus(), 350);
            return () => clearTimeout(timer);
        }
    }, [isOpen, view]);

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
                    navigate('/dashboard');
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
                    navigate('/dashboard');
                }
            }
        } catch (err: unknown) {
            if (err instanceof ApiError) {
                let mainError = getErrorMessage(err) || 'Erro ao processar solicitação';
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
        } catch (err: unknown) {
            if (err instanceof ApiError) {
                let mainError = getErrorMessage(err) || 'Erro ao processar solicitação';
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
                setError(getErrorMessage(err) || 'Falha ao enviar código.');
            }
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
                    navigate('/dashboard');
                }
            } catch (err: unknown) {
                setError(getErrorMessage(err) || 'Falha na autenticação via Google');
            } finally {
                setLoading(false);
            }
        },
        onError: () => setError('Falha no login com Google')
    });

    const canGoBack = view !== 'login';
    const isRegisterFlow = view !== 'login';
    const totalSteps = 3;
    const currentStep = VIEW_STEPS[view];

    if (!isOpen) return null;

    return (
        <ModalOverlay
            onClose={onClose}
            className="login-modal-overlay"
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9999,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                background: 'rgba(0, 20, 26, 0.88)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
            }}
        >
            <AnimatePresence>
                <motion.div
                    key={view}
                    initial={{ opacity: 0, y: '100%' }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: '100%' }}
                    transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                    className="login-modal-card"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* ── Sticky Header ── */}
                    <div className="login-modal-header">
                        {/* Drag handle */}
                        <div className="login-modal-handle" />

                        {/* Nav row */}
                        <div className="login-modal-nav">
                            {canGoBack ? (
                                <button
                                    onClick={() => {
                                        if (view === 'register_code') setView('register_method');
                                        else if (view === 'register_method') setView('register_form');
                                        else setView('login');
                                        setError(''); setFieldErrors({}); setCode('');
                                    }}
                                    className="login-modal-icon-btn"
                                    aria-label="Voltar"
                                >
                                    <ChevronLeft size={22} />
                                </button>
                            ) : (
                                <div style={{ width: '44px' }} />
                            )}

                            <h2 className="login-modal-title">
                                {view === 'login' && 'Entrar'}
                                {view === 'register_form' && 'Criar conta'}
                                {view === 'register_method' && 'Verificação'}
                                {view === 'register_code' && 'Código'}
                            </h2>

                            <button onClick={onClose} className="login-modal-icon-btn" aria-label="Fechar">
                                <X size={20} />
                            </button>
                        </div>

                        {/* Step indicator for register flow */}
                        {isRegisterFlow && (
                            <div className="login-modal-steps">
                                {[1, 2, 3].map(step => (
                                    <div
                                        key={step}
                                        className={`login-modal-step-dot ${step <= currentStep ? 'active' : ''} ${step === currentStep ? 'current' : ''}`}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Subtitle */}
                        <p className="login-modal-subtitle">
                            {view === 'login' && 'Acesse sua conta para gerenciar agendamentos.'}
                            {view === 'register_form' && 'Preencha seus dados para criar sua conta.'}
                            {view === 'register_method' && 'Como deseja receber seu código de verificação?'}
                            {view === 'register_code' && `Enviamos um código para seu ${selectedMethod === 'email' ? 'e-mail' : 'telefone'}.`}
                        </p>
                    </div>

                    {/* ── Scrollable Content ── */}
                    <div className="login-modal-body">
                        {error && (
                            <div className="login-modal-error">
                                {translateError(error)}
                            </div>
                        )}

                        <form onSubmit={handleSubmit} noValidate>
                            {(view === 'login' || view === 'register_form') && (
                                <>
                                    {/* Google — fastest path */}
                                    <button type="button" onClick={() => handleGoogleLogin()} className="login-google-btn">
                                        <svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                                            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.7 17.74 9.5 24 9.5z" />
                                            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                                            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                                            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                                        </svg>
                                        {view === 'register_form' ? 'Continuar com Google' : 'Entrar com Google'}
                                    </button>

                                    <div className="login-modal-divider">
                                        <div className="login-modal-divider-line" />
                                        <span className="login-modal-divider-text">ou com e-mail</span>
                                        <div className="login-modal-divider-line" />
                                    </div>

                                    {view === 'register_form' && (
                                        <>
                                            <div className="login-field">
                                                <label htmlFor="login-name" className="login-label">Nome</label>
                                                <input
                                                    ref={firstInputRef}
                                                    id="login-name"
                                                    type="text"
                                                    placeholder="Seu nome"
                                                    value={name}
                                                    onChange={e => setName(e.target.value)}
                                                    className={`login-input ${fieldErrors.name ? 'login-input--error' : ''}`}
                                                    autoComplete="name"
                                                    required
                                                />
                                                {fieldErrors.name && <div className="login-field-error">{translateError(fieldErrors.name)}</div>}
                                            </div>
                                            <div className="login-field">
                                                <label htmlFor="login-phone" className="login-label">Telefone</label>
                                                <input
                                                    id="login-phone"
                                                    type="tel"
                                                    inputMode="tel"
                                                    placeholder="(21) 99999-0000"
                                                    value={phone}
                                                    onChange={e => setPhone(maskPhone(e.target.value))}
                                                    className={`login-input ${fieldErrors.phone ? 'login-input--error' : ''}`}
                                                    autoComplete="tel"
                                                    required
                                                />
                                                {fieldErrors.phone && <div className="login-field-error">{translateError(fieldErrors.phone)}</div>}
                                            </div>
                                        </>
                                    )}

                                    <div className="login-field">
                                        <label htmlFor="login-email" className="login-label">E-mail</label>
                                        <input
                                            ref={view === 'login' ? firstInputRef : undefined}
                                            id="login-email"
                                            type="email"
                                            inputMode="email"
                                            placeholder="seu@email.com"
                                            value={email}
                                            onChange={e => setEmail(maskEmail(e.target.value))}
                                            className={`login-input ${fieldErrors.email ? 'login-input--error' : ''}`}
                                            autoComplete="email"
                                            required
                                        />
                                        {fieldErrors.email && <div className="login-field-error">{translateError(fieldErrors.email)}</div>}
                                    </div>

                                    <div className="login-field" style={{ marginBottom: '24px' }}>
                                        <label htmlFor="login-password" className="login-label">Senha</label>
                                        <div className="login-input-wrapper">
                                            <input
                                                id="login-password"
                                                type={showPassword ? 'text' : 'password'}
                                                placeholder="••••••"
                                                value={password}
                                                onChange={e => setPassword(e.target.value)}
                                                className={`login-input login-input--has-action ${fieldErrors.password ? 'login-input--error' : ''}`}
                                                autoComplete={view === 'register_form' ? 'new-password' : 'current-password'}
                                                minLength={6}
                                                required
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowPassword(p => !p)}
                                                className="login-input-action"
                                                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                                                tabIndex={-1}
                                            >
                                                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                                            </button>
                                        </div>
                                        {fieldErrors.password && <div className="login-field-error">{translateError(fieldErrors.password)}</div>}
                                    </div>

                                    <button type="submit" disabled={loading} className="login-primary-btn">
                                        {loading ? <Loader2 size={20} className="login-spinner" /> : (view === 'register_form' ? 'Continuar' : 'Entrar')}
                                    </button>
                                </>
                            )}

                            {view === 'register_method' && (
                                <div className="login-methods">
                                    <button type="button" onClick={() => handleSelectMethod('email')} disabled={loading} className="login-method-btn">
                                        <div className="login-method-icon"><Mail size={20} /></div>
                                        <div className="login-method-info">
                                            <span className="login-method-title">E-mail</span>
                                            <span className="login-method-detail">{email}</span>
                                        </div>
                                        <ChevronLeft size={16} style={{ transform: 'rotate(180deg)', opacity: 0.3 }} />
                                    </button>
                                    <button type="button" onClick={() => handleSelectMethod('phone')} disabled={loading} className="login-method-btn">
                                        <div className="login-method-icon"><MessageCircle size={20} /></div>
                                        <div className="login-method-info">
                                            <span className="login-method-title">WhatsApp / SMS</span>
                                            <span className="login-method-detail">{phone}</span>
                                        </div>
                                        <ChevronLeft size={16} style={{ transform: 'rotate(180deg)', opacity: 0.3 }} />
                                    </button>
                                </div>
                            )}

                            {view === 'register_code' && (
                                <>
                                    <div className="login-field" style={{ marginBottom: '24px' }}>
                                        <label htmlFor="login-code" className="login-label">Código de 6 dígitos</label>
                                        <input
                                            ref={firstInputRef}
                                            id="login-code"
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            placeholder="000000"
                                            value={code}
                                            onChange={e => setCode(e.target.value.replace(/\D/g, '').substring(0, 6))}
                                            className={`login-input login-input--code ${fieldErrors.code ? 'login-input--error' : ''}`}
                                            autoFocus
                                            required
                                        />
                                        {fieldErrors.code && <div className="login-field-error">{translateError(fieldErrors.code)}</div>}
                                    </div>
                                    <button type="submit" disabled={loading || code.length !== 6} className="login-primary-btn">
                                        {loading ? <Loader2 size={20} className="login-spinner" /> : 'Confirmar'}
                                    </button>
                                </>
                            )}
                        </form>

                        {/* Toggle login ↔ register */}
                        {(view === 'login' || view === 'register_form') && (
                            <button
                                onClick={() => { setView(view === 'login' ? 'register_form' : 'login'); setError(''); setFieldErrors({}); }}
                                className="login-toggle-btn"
                            >
                                {view === 'register_form'
                                    ? <>Já tem conta? <strong>Faça login</strong></>
                                    : <>Novo aqui? <strong>Crie sua conta</strong></>
                                }
                            </button>
                        )}

                        {/* Dev mock credentials */}
                        <div className="login-mock-section">
                            <div className="login-mock-label"><ShieldCheck size={11} /> Teste rápido:</div>
                            <div className="login-mock-btns">
                                <button type="button" className="login-mock-btn" onClick={() => { setEmail('admin@studio.com'); setPassword('admin123'); }}>Admin</button>
                                <button type="button" className="login-mock-btn" onClick={() => { setEmail('cliente@teste.com'); setPassword('cliente123'); }}>Cliente</button>
                            </div>
                        </div>
                    </div>
                </motion.div>
            </AnimatePresence>
        </ModalOverlay>
    );
}
