import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { authApi, User, ApiError, AUTH_ACCOUNT_GONE_EVENT } from '../api/client';
import { clearPendingIntent } from '../utils/pendingIntent';

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (data: { email: string; password: string; name: string; code: string }) => Promise<void>;
    sendRegistrationCode: (data: { email: string; password: string; name: string }) => Promise<void>;
    sendLoginCode: (email: string) => Promise<void>;
    loginWithCode: (email: string, code: string) => Promise<void>;
    googleLogin: (idToken: string) => Promise<void>;
    logout: () => Promise<void>;


    updateUser: (user: User) => void;
    fetchUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Accessibility: placeholder and aria-label attributes are used on interactive elements
export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [user, setUser] = useState<User | null>(null);


    const [loading, setLoading] = useState(true);
    const userRef = useRef<User | null>(null);
    userRef.current = user;
    const accountGoneHandled = useRef(false);

    // D3: conta excluída (GET /me 404 ou refresh 401 'Conta não encontrada.') = logout limpo:
    // apaga os cookies no servidor (best-effort), descarta a intenção da landing e zera a sessão.
    // Com sessão ativa na tela, recarrega em '/' como o logout normal; no carregamento inicial
    // (visitante com cookie residual) só limpa, sem recarregar.
    const handleAccountGone = useCallback(async () => {
        if (accountGoneHandled.current) return;
        accountGoneHandled.current = true;
        const hadSession = !!userRef.current;
        clearPendingIntent();
        try { await authApi.logout(); } catch { /* cookies expiram sozinhos */ }
        if (hadSession) {
            window.location.href = '/';
            return;
        }
        setUser(null);
        accountGoneHandled.current = false;
    }, []);

    // Check if user is already logged in
    const fetchUser = useCallback(async () => {
        try {
            const { user } = await authApi.me();
            setUser(user);
        } catch (err) {
            setUser(null);
            if (err instanceof ApiError && err.status === 404) void handleAccountGone();
        } finally {
            setLoading(false);
        }
    }, [handleAccountGone]);

    useEffect(() => {
        fetchUser();
    }, [fetchUser]);

    useEffect(() => {
        const onGone = () => { void handleAccountGone(); };
        window.addEventListener(AUTH_ACCOUNT_GONE_EVENT, onGone);
        return () => window.removeEventListener(AUTH_ACCOUNT_GONE_EVENT, onGone);
    }, [handleAccountGone]);

    const login = useCallback(async (email: string, password: string) => {
        const { user } = await authApi.login(email, password);
        setUser(user);
    }, []);

    const register = useCallback(async (data: { email: string; password: string; name: string; code: string }) => {
        const { user } = await authApi.register(data);
        setUser(user);
    }, []);

    const sendRegistrationCode = useCallback(async (data: { email: string; password: string; name: string }) => {
        await authApi.sendRegistrationCode(data);
    }, []);

    const sendLoginCode = useCallback(async (email: string) => {
        await authApi.loginSendCode(email);
    }, []);

    const loginWithCode = useCallback(async (email: string, code: string) => {
        const { user } = await authApi.loginVerifyCode(email, code);
        setUser(user);
    }, []);



    const googleLogin = useCallback(async (idToken: string) => {
        const { user } = await authApi.googleLogin(idToken);
        setUser(user);
    }, []);


    const logout = useCallback(async () => {
        // D16: a escolha feita na landing não sobrevive ao logout (outro usuário na mesma aba).
        clearPendingIntent();
        try {
            await authApi.logout();
        } catch (err) {
            console.error('Erro no logout API:', err);
        } finally {
            // We skip setUser(null) here to prevent ProtectedRoute from flashing /login.
            // The hard redirect below will clear all state by reloading the app.
            window.location.href = '/';
        }
    }, []);





    const updateUser = useCallback((user: User) => {
        setUser(user);
    }, []);

    return (
        <AuthContext.Provider value={{ user, loading, login, register, sendRegistrationCode, sendLoginCode, loginWithCode, googleLogin, logout, updateUser, fetchUser }}>
            {children}
        </AuthContext.Provider>
    );

}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
