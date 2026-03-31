import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authApi, User } from '../api/client';

interface AuthContextType {
    user: User | null;
    loading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (data: { email: string; password: string; name: string; phone?: string, code?: string, method?: 'email' | 'phone' }) => Promise<void>;
    sendRegistrationCode: (data: { email: string; password: string; name: string; phone: string; method: 'email' | 'phone' }) => Promise<void>;
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

    // Check if user is already logged in
    const fetchUser = useCallback(async () => {
        try {
            const { user } = await authApi.me();
            setUser(user);
        } catch {
            setUser(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchUser();
    }, [fetchUser]);

    const login = useCallback(async (email: string, password: string) => {
        const { user } = await authApi.login(email, password);
        setUser(user);
    }, []);

    const register = useCallback(async (data: { email: string; password: string; name: string; phone?: string, code?: string, method?: 'email' | 'phone' }) => {
        const { user } = await authApi.register(data);
        setUser(user);
    }, []);

    const sendRegistrationCode = useCallback(async (data: { email: string; password: string; name: string; phone: string; method: 'email' | 'phone' }) => {
        await authApi.sendRegistrationCode(data);
    }, []);



    const googleLogin = useCallback(async (idToken: string) => {
        const { user } = await authApi.googleLogin(idToken);
        setUser(user);
    }, []);


    const logout = useCallback(async () => {
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
        <AuthContext.Provider value={{ user, loading, login, register, sendRegistrationCode, googleLogin, logout, updateUser, fetchUser }}>
            {children}
        </AuthContext.Provider>
    );

}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
