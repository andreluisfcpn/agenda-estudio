import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UIProvider } from './context/UIContext';
import { NavigationProvider, useNavigation } from './context/NavigationContext';
import LoginPage from './pages/LoginPage';
import LandingPage from './pages/LandingPage';
import AmbientBackground from './components/AmbientBackground';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import ProfileModal from './components/ProfileModal';
import BottomTabBar from './components/BottomTabBar';
import { PageTransitionLoader } from './components/PageTransitionLoader';
import OfflineIndicator from './components/OfflineIndicator';
import UpdateBanner from './components/UpdateBanner';
import { usePushSubscription } from './hooks/usePushSubscription';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { loadPaymentMethods } from './constants/paymentMethods';

// Lazy-loaded pages (code-split for faster navigation)
const DashboardPage = React.lazy(() => import('./pages/DashboardPage'));
const CalendarPage = React.lazy(() => import('./pages/CalendarPage'));
const MyBookingsPage = React.lazy(() => import('./pages/MyBookingsPage'));
const MyContractsPage = React.lazy(() => import('./pages/MyContractsPage'));
const MyPaymentsPage = React.lazy(() => import('./pages/MyPaymentsPage'));
const AdminClientsPage = React.lazy(() => import('./pages/AdminClientsPage'));
const AdminBookingsPage = React.lazy(() => import('./pages/AdminBookingsPage'));
const AdminContractsPage = React.lazy(() => import('./pages/AdminContractsPage'));
const AdminPricingPage = React.lazy(() => import('./pages/AdminPricingPage'));
const AdminServicesPage = React.lazy(() => import('./pages/AdminServicesPage'));
const AdminTodayPage = React.lazy(() => import('./pages/AdminTodayPage'));
const AdminFinancePage = React.lazy(() => import('./pages/AdminFinancePage'));
const AdminReportsPage = React.lazy(() => import('./pages/AdminReportsPage'));
const ClientProfilePage = React.lazy(() => import('./pages/ClientProfilePage'));

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
    const { isTransitioning, isExiting } = useNavigation();
    usePushSubscription();
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
            <OfflineIndicator />
            <AmbientBackground />
            <Topbar
                onToggleSidebar={toggleSidebar}
                onProfileClick={() => setShowProfile(true)}
            />
            <Sidebar 
                collapsed={sidebarCollapsed} 
                onProfileClick={() => setShowProfile(true)}
            />

            {/* Transition overlay — shown BEFORE route change */}
            {isTransitioning && <PageTransitionLoader exiting={isExiting} />}

            <main className="main-content">
                <Suspense fallback={<PageTransitionLoader />}>
                    {children}
                </Suspense>
            </main>

            <ProfileModal
                    isOpen={showProfile}
                    onClose={() => setShowProfile(false)}
                    onSuccess={(msg) => { setShowProfile(false); setToast(msg); }}
                />

            {toast && <SuccessToast message={toast} onDone={() => setToast('')} />}

            <UpdateBanner />
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
                        <NavigationProvider>
                            <AppRoutes />
                        </NavigationProvider>
                    </AuthProvider>
                </BrowserRouter>
            </UIProvider>
        </GoogleOAuthProvider>
    );
}
