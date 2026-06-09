import { getErrorMessage } from '../utils/errors';
import { useState, useEffect, useRef, FormEvent } from 'react';
import BottomSheetModal from './BottomSheetModal';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Loader2, ChevronLeft, Eye, EyeOff, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { maskEmail, translateError } from '../utils/mask';
import { ApiError } from '../api/client';
import { focusUnlessTouch } from '../utils/focus';
import { useGoogleLogin } from '@react-oauth/google';

interface LoginModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type ViewType = 'login' | 'login_code' | 'register_form' | 'register_code' | 'forgot_password';

const VIEW_STEPS: Record<ViewType, number> = {
    login: 0,
    login_code: 0,
    forgot_password: 0,
    register_form: 1,
    register_code: 2,
};

// Animation variants for smooth sliding
const variants = {
    enter: (direction: number) => ({ x: direction > 0 ? 50 : -50, opacity: 0 }),
    center: { zIndex: 1, x: 0, opacity: 1 },
    exit: (direction: number) => ({ zIndex: 0, x: direction < 0 ? 50 : -50, opacity: 0 }),
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginModal({ isOpen, onClose }: LoginModalProps) {
    const navigate = useNavigate();
    const { login, register, googleLogin, sendRegistrationCode, sendLoginCode, loginWithCode } = useAuth();
    const firstInputRef = useRef<HTMLInputElement>(null);

    const [view, setView] = useState<ViewType>('login');
    const [prevView, setPrevView] = useState<ViewType>('login');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [code, setCode] = useState('');
    const [resendIn, setResendIn] = useState(0); // segundos restantes do cooldown de reenvio

    // Direction calculation for animation (1 = slide left, -1 = slide right)
    const direction = VIEW_STEPS[view] >= VIEW_STEPS[prevView] ? 1 : -1;

    // Tick down the resend cooldown (backend impõe 30s por alvo).
    useEffect(() => {
        if (resendIn <= 0) return;
        const t = setInterval(() => setResendIn(s => Math.max(0, s - 1)), 1000);
        return () => clearInterval(t);
    }, [resendIn]);
    const startResendCooldown = () => setResendIn(30);

    const navigateTo = (newView: ViewType) => {
        setPrevView(view);
        setView(newView);
        setError('');
        setSuccessMessage('');
        setFieldErrors({});
    };

    // Focus first input when modal opens or view changes.
    useEffect(() => {
        if (isOpen) {
            return focusUnlessTouch(firstInputRef.current, 350);
        }
        // Reset view when closed — capture + clear the timer so a quick reopen doesn't yank the view.
        const t = setTimeout(() => { setView('login'); setCode(''); }, 300);
        return () => clearTimeout(t);
    }, [isOpen, view]);

    const postAuthNavigate = () => {
        onClose();
        const pending = sessionStorage.getItem('pendingBooking');
        if (pending) {
            const { date, time } = JSON.parse(pending);
            sessionStorage.removeItem('pendingBooking');
            navigate('/calendar', { state: { preSelectedDate: date, preSelectedTime: time } });
        } else {
            navigate('/dashboard');
        }
    };

    const applyError = (err: unknown) => {
        if (err instanceof ApiError) {
            let mainError = getErrorMessage(err) || 'Erro ao processar solicitação';
            if (err.details && Array.isArray(err.details)) {
                const mapped: Record<string, string> = {};
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                err.details.forEach((issue: any) => {
                    const key = issue.path.join('.');
                    mapped[key] = issue.message;
                    if (mainError === 'Dados inválidos.' || mainError === 'Bad Request') mainError = issue.message;
                });
                setFieldErrors(mapped);
            } else {
                setFieldErrors((err.details as Record<string, string>) || {});
            }
            setError(mainError);
        } else {
            setError('Erro de conexão com o servidor. Tente novamente.');
        }
    };

    const handleGoogleCallback = useGoogleLogin({
        onSuccess: async (tokenResponse) => {
            setError('');
            setLoading(true);
            try {
                await googleLogin(tokenResponse.access_token);
                postAuthNavigate();
            } catch (err: unknown) {
                setError(getErrorMessage(err) || 'Falha na autenticação via Google');
            } finally {
                setLoading(false);
            }
        },
        onError: () => setError('Falha no login com Google'),
        scope: 'openid email profile',
    });

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setFieldErrors({});
        setLoading(true);
        try {
            if (view === 'forgot_password') {
                if (!email) {
                    setFieldErrors({ email: 'Informe um e-mail válido' });
                    setLoading(false);
                    return;
                }
                // Mock até existir endpoint dedicado de recuperação.
                await new Promise(r => setTimeout(r, 1000));
                setSuccessMessage('As instruções de recuperação foram enviadas para o seu e-mail.');
                setLoading(false);
                return;
            }

            if (view === 'register_form') {
                const errors: Record<string, string> = {};
                if (!name) errors.name = 'Nome é obrigatório';
                if (!email) errors.email = 'E-mail é obrigatório';
                else if (!EMAIL_REGEX.test(email)) errors.email = 'E-mail inválido';
                if (!password) errors.password = 'Senha é obrigatória';
                else if (password.length < 6) errors.password = 'Senha deve ter no mínimo 6 caracteres';

                if (Object.keys(errors).length > 0) {
                    setFieldErrors(errors);
                    setError('Por favor, verifique os campos em vermelho.');
                    setLoading(false);
                    return;
                }

                // Envia o código de verificação por e-mail e avança para a etapa do código.
                await sendRegistrationCode({ email, password, name });
                setCode('');
                startResendCooldown();
                navigateTo('register_code');
                return;
            }

            if (view === 'register_code') {
                await register({ email, password, name, code });
                postAuthNavigate();
                return;
            }

            if (view === 'login') {
                await login(email, password);
                postAuthNavigate();
                return;
            }

            if (view === 'login_code') {
                await loginWithCode(email, code);
                postAuthNavigate();
                return;
            }
        } catch (err: unknown) {
            applyError(err);
        } finally {
            setLoading(false);
        }
    };

    // "Entrar com código" — request an OTP for an existing account, then go to the code step.
    const handleLoginSendCode = async () => {
        setError('');
        setSuccessMessage('');
        setFieldErrors({});
        if (!email || !EMAIL_REGEX.test(email)) {
            setFieldErrors({ email: 'Informe um e-mail válido' });
            return;
        }
        setLoading(true);
        try {
            await sendLoginCode(email);
            setCode('');
            startResendCooldown();
            navigateTo('login_code');
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Falha ao enviar o código.');
        } finally {
            setLoading(false);
        }
    };

    // Reenviar código — funciona tanto no login quanto no cadastro (mesma view de código).
    const handleResendCode = async () => {
        if (resendIn > 0) return;
        setError('');
        setSuccessMessage('');
        setLoading(true);
        try {
            if (view === 'register_code') await sendRegistrationCode({ email, password, name });
            else await sendLoginCode(email);
            setSuccessMessage('Novo código enviado para seu e-mail.');
            startResendCooldown();
        } catch (err: unknown) {
            setError(getErrorMessage(err) || 'Falha ao reenviar o código.');
        } finally {
            setLoading(false);
        }
    };

    const canGoBack = view !== 'login';
    const isRegisterFlow = view.startsWith('register_');
    const currentStep = VIEW_STEPS[view];

    const getTitle = () => {
        switch (view) {
            case 'login': return 'Acesse sua conta';
            case 'login_code': return 'Entrar com código';
            case 'forgot_password': return 'Recuperar Senha';
            case 'register_form': return 'Criar Conta';
            case 'register_code': return 'Confirme seu e-mail';
        }
    };

    const getSubtitle = () => {
        switch (view) {
            case 'login': return 'Gerencie seus agendamentos e contratos.';
            case 'login_code': return `Enviamos um código de 6 dígitos para ${email}.`;
            case 'forgot_password': return 'Enviaremos instruções para o seu e-mail.';
            case 'register_form': return 'Preencha seus dados para começar.';
            case 'register_code': return `Enviamos um código de 6 dígitos para ${email}.`;
        }
    };

    return (
        <BottomSheetModal isOpen={isOpen} onClose={onClose} hideHeader={true} className="login-modal-sheet">
            <div className="login-modal-card" onClick={(e) => e.stopPropagation()}>
                {/* ── Sticky Header ── */}
                <div className="login-modal-header">
                    <div className="login-modal-nav">
                        {canGoBack ? (
                            <button
                                onClick={() => {
                                    if (view === 'register_code') navigateTo('register_form');
                                    else if (view === 'login_code') navigateTo('login');
                                    else navigateTo('login');
                                }}
                                className="login-modal-icon-btn"
                                aria-label="Voltar"
                            >
                                <ChevronLeft size={22} />
                            </button>
                        ) : (
                            <div style={{ width: '44px' }} />
                        )}

                        <h2 className="login-modal-title">{getTitle()}</h2>

                        <button onClick={onClose} className="login-modal-icon-btn" aria-label="Fechar">
                            <X size={20} />
                        </button>
                    </div>

                    {/* Step indicator for register flow (2 steps) */}
                    {isRegisterFlow && (
                        <div className="login-modal-steps">
                            {[1, 2].map(step => (
                                <div
                                    key={step}
                                    className={`login-modal-step-dot ${step <= currentStep ? 'active' : ''} ${step === currentStep ? 'current' : ''}`}
                                />
                            ))}
                        </div>
                    )}

                    <p className="login-modal-subtitle">{getSubtitle()}</p>
                </div>

                {/* ── Smooth Crossfade/Slide Body ── */}
                <div className="login-modal-body-container">
                    <AnimatePresence custom={direction} mode="wait" initial={false}>
                        <motion.div
                            key={view}
                            custom={direction}
                            variants={variants}
                            initial="enter"
                            animate="center"
                            exit="exit"
                            transition={{ duration: 0.25, ease: 'easeOut' }}
                            className="login-modal-body"
                        >
                            {error && (
                                <div className="login-modal-alert login-modal-alert--error" role="alert" aria-live="assertive">{translateError(error)}</div>
                            )}
                            {successMessage && (
                                <div className="login-modal-alert login-modal-alert--success" role="status" aria-live="polite">{successMessage}</div>
                            )}

                            <form onSubmit={handleSubmit} noValidate>
                                {/* ── VIEW: LOGIN & REGISTER FORM ── */}
                                {(view === 'login' || view === 'register_form') && (
                                    <>
                                        {view === 'register_form' && (
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
                                            </div>
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

                                        <div className="login-field login-field--password">
                                            <div className="login-label-row">
                                                <label htmlFor="login-password" className="login-label">Senha</label>
                                                {view === 'login' && (
                                                    <button type="button" className="login-forgot-btn" onClick={() => navigateTo('forgot_password')}>
                                                        Esqueceu a senha?
                                                    </button>
                                                )}
                                            </div>
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

                                        {/* Login alternativo por código de e-mail */}
                                        {view === 'login' && (
                                            <button type="button" onClick={handleLoginSendCode} disabled={loading} className="login-secondary-btn">
                                                <Mail size={18} /> Entrar com código por e-mail
                                            </button>
                                        )}

                                        <div className="login-modal-divider">
                                            <div className="login-modal-divider-line" />
                                            <span className="login-modal-divider-text">OU</span>
                                            <div className="login-modal-divider-line" />
                                        </div>

                                        <button type="button" onClick={() => handleGoogleCallback()} className="login-google-btn">
                                            <svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                                                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.7 17.74 9.5 24 9.5z" />
                                                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                                                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                                                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                                            </svg>
                                            Google
                                        </button>
                                    </>
                                )}

                                {/* ── VIEW: FORGOT PASSWORD ── */}
                                {view === 'forgot_password' && (
                                    <div className="login-form-slide">
                                        <div className="login-field">
                                            <label htmlFor="forgot-email" className="login-label">Seu e-mail cadastrado</label>
                                            <input
                                                ref={firstInputRef}
                                                id="forgot-email"
                                                type="email"
                                                placeholder="seu@email.com"
                                                value={email}
                                                onChange={e => setEmail(maskEmail(e.target.value))}
                                                className={`login-input ${fieldErrors.email ? 'login-input--error' : ''}`}
                                                required
                                            />
                                        </div>
                                        <button type="submit" disabled={loading} className="login-primary-btn" style={{ marginTop: '24px' }}>
                                            {loading ? <Loader2 size={20} className="login-spinner" /> : 'Enviar Recuperação'}
                                        </button>
                                    </div>
                                )}

                                {/* ── VIEW: CODE (login OR register) ── */}
                                {(view === 'login_code' || view === 'register_code') && (
                                    <div className="login-form-slide">
                                        <div className="login-field" style={{ marginBottom: '20px' }}>
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
                                                autoComplete="one-time-code"
                                                required
                                            />
                                        </div>
                                        <button type="submit" disabled={loading || code.length !== 6} className="login-primary-btn">
                                            {loading ? <Loader2 size={20} className="login-spinner" /> : (view === 'register_code' ? 'Criar conta' : 'Entrar')}
                                        </button>
                                        <button type="button" onClick={handleResendCode} disabled={loading || resendIn > 0} className="login-toggle-btn" style={{ marginTop: '12px' }}>
                                            {resendIn > 0 ? `Reenviar código em ${resendIn}s` : <>Não recebeu? <strong>Reenviar código</strong></>}
                                        </button>
                                    </div>
                                )}
                            </form>

                            {/* Toggle Login ↔ Register */}
                            {(view === 'login' || view === 'register_form') && (
                                <button
                                    onClick={() => navigateTo(view === 'login' ? 'register_form' : 'login')}
                                    className="login-toggle-btn"
                                >
                                    {view === 'register_form'
                                        ? <>Já tem conta? <strong>Faça login</strong></>
                                        : <>Novo aqui? <strong>Crie sua conta</strong></>
                                    }
                                </button>
                            )}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </div>
        </BottomSheetModal>
    );
}
