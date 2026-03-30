import React, { useState, useEffect, FormEvent } from 'react';
import { useAuth } from '../context/AuthContext';
import { pricingApi } from '../api/client';

export default function LoginPage() {
    const { login, register } = useAuth();
    const [isRegister, setIsRegister] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [studioName, setStudioName] = useState('Estúdio Búzios Digital');
    const [studioLogo, setStudioLogo] = useState('https://buzios.digital/wp-content/uploads/2025/01/logo-site-branca.svg');

    useEffect(() => {
        pricingApi.getBusinessConfigPublic().then(({ config }) => {
            if (config.studio_name) setStudioName(String(config.studio_name));
            if (config.studio_logo_url) setStudioLogo(String(config.studio_logo_url));
        }).catch(() => {});
    }, []);

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            if (isRegister) {
                await register({ email, password, name, phone });
            } else {
                await login(email, password);
            }
        } catch (err: any) {
            setError(err.message || 'Erro ao fazer login');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="login-page">
            <div className="login-card" style={{ textAlign: 'center' }}>
                <img
                    src={studioLogo}
                    alt={studioName}
                    style={{ height: '40px', marginBottom: '20px' }}
                />
                <h1 style={{ fontSize: '1.75rem', marginBottom: '8px' }}>{studioName}</h1>
                <p>{isRegister ? 'Crie sua conta para agendar' : 'Entre para gerenciar seus agendamentos'}</p>

                {error && <div className="error-message">{error}</div>}

                <form onSubmit={handleSubmit}>
                    {isRegister && (
                        <>
                            <div className="form-group">
                                <label className="form-label" htmlFor="name">Nome</label>
                                <input
                                    id="name"
                                    className="form-input"
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="Seu nome artístico"
                                    required
                                />
                            </div>
                            <div className="form-group">
                                <label className="form-label" htmlFor="phone">Telefone <span style={{ color: '#ff4444' }}>*</span></label>
                                <input
                                    id="phone"
                                    className="form-input"
                                    type="tel"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    placeholder="(21) 99999-0000"
                                    required
                                />
                            </div>
                        </>
                    )}

                    <div className="form-group">
                        <label className="form-label" htmlFor="email">E-mail</label>
                        <input
                            id="email"
                            className="form-input"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="seu@email.com"
                            required
                        />
                    </div>

                    <div className="form-group">
                        <label className="form-label" htmlFor="password">Senha</label>
                        <input
                            id="password"
                            className="form-input"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••"
                            minLength={6}
                            required
                        />
                    </div>

                    <button className="btn btn-primary" type="submit" disabled={loading}>
                        {loading ? '⏳ Aguarde...' : isRegister ? '🚀 Criar Conta' : '🔓 Entrar'}
                    </button>
                </form>

                <div className="login-divider">ou</div>

                <div className="login-footer">
                    <button
                        className="btn btn-ghost"
                        onClick={() => { setIsRegister(!isRegister); setError(''); }}
                        style={{ width: '100%' }}
                    >
                        {isRegister ? 'Já tem conta? Faça login' : 'Novo aqui? Crie sua conta'}
                    </button>
                </div>

                <div style={{ marginTop: '24px', padding: '16px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    <strong style={{ color: 'var(--text-secondary)', display: 'block', marginBottom: '8px' }}>🧪 Login Rápido (Contas de Teste):</strong>
                    <div style={{ display: 'grid', gap: '6px' }}>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start', fontSize: '0.75rem' }} onClick={() => { setEmail('admin@studio.com'); setPassword('admin123'); }}>🛡️ Admin [admin@studio.com] (admin123)</button>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start', fontSize: '0.75rem' }} onClick={() => { setEmail('cliente@teste.com'); setPassword('cliente123'); }}>👤 Cliente Principal [cliente@teste.com] (cliente123)</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
