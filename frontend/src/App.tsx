import React, { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UIProvider } from './context/UIContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CalendarPage from './pages/CalendarPage';
import MyBookingsPage from './pages/MyBookingsPage';
import MyContractsPage from './pages/MyContractsPage';
import MyPaymentsPage from './pages/MyPaymentsPage';
import AdminClientsPage from './pages/AdminClientsPage';
import AdminBookingsPage from './pages/AdminBookingsPage';
import AdminContractsPage from './pages/AdminContractsPage';
import AdminPricingPage from './pages/AdminPricingPage';
import AdminServicesPage from './pages/AdminServicesPage';
import AdminTodayPage from './pages/AdminTodayPage';
import AdminFinancePage from './pages/AdminFinancePage';
import AdminReportsPage from './pages/AdminReportsPage';
import AmbientBackground from './components/AmbientBackground';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import ProfileModal from './components/ProfileModal';
import BottomTabBar from './components/BottomTabBar';
import ClientProfilePage from './pages/ClientProfilePage';
import LandingPage from './pages/LandingPage';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { loadPaymentMethods } from './constants/paymentMethods';

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

// ─── Layout ─────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
    const [showProfile, setShowProfile] = useState(false);
    const [toast, setToast] = useState('');
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        try { return localStorage.getItem('sidebar-collapsed') === 'true'; } catch { return false; }
    });

    const toggleSidebar = useCallback(() => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            try { localStorage.setItem('sidebar-collapsed', String(next)); } catch {}
            return next;
        });
    }, []);

    // Ctrl+B shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                toggleSidebar();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [toggleSidebar]);

    return (
        <div className={`app-layout ${sidebarCollapsed ? 'app-layout--sidebar-collapsed' : ''}`}>
            <AmbientBackground />
            <Topbar
                onToggleSidebar={toggleSidebar}
                onProfileClick={() => setShowProfile(true)}
            />
            <Sidebar 
                collapsed={sidebarCollapsed} 
                onProfileClick={() => setShowProfile(true)}
            />

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

            <BottomTabBar />
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
            <Route path="/meus-pagamentos" element={<ProtectedRoute><MyPaymentsPage /></ProtectedRoute>} />

            {/* Admin routes */}
            <Route path="/admin/today" element={<ProtectedRoute><AdminRoute><AdminTodayPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/bookings" element={<ProtectedRoute><AdminRoute><AdminBookingsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/clients" element={<ProtectedRoute><AdminRoute><AdminClientsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/clients/:id" element={<ProtectedRoute><AdminRoute><ClientProfilePage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/contracts" element={<ProtectedRoute><AdminRoute><AdminContractsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/pricing" element={<ProtectedRoute><AdminRoute><AdminPricingPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/services" element={<ProtectedRoute><AdminRoute><AdminServicesPage /></AdminRoute></ProtectedRoute>} />
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
