import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UIProvider } from './context/UIContext';
import { NavigationProvider } from './context/NavigationContext';
import LoginPage from './pages/LoginPage';
import LandingPage from './pages/LandingPage';
import AmbientBackground from './components/AmbientBackground';
import Sidebar from './components/Sidebar';
import Topbar from './components/Topbar';
import BottomTabBar from './components/BottomTabBar';
import { PageTransitionLoader } from './components/PageTransitionLoader';
import OfflineIndicator from './components/OfflineIndicator';
import UpdateBanner from './components/UpdateBanner';
import ErrorBoundary from './components/ErrorBoundary';
import { usePushSubscription } from './hooks/usePushSubscription';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { loadPaymentMethods } from './constants/paymentMethods';

// Lazy-loaded pages (code-split for faster navigation)
const DashboardPage = React.lazy(() => import('./pages/DashboardPage'));
const CalendarPage = React.lazy(() => import('./pages/CalendarPage'));
const MyBookingsPage = React.lazy(() => import('./pages/MyBookingsPage'));
const MyResultsPage = React.lazy(() => import('./pages/MyResultsPage'));
const MyContractsPage = React.lazy(() => import('./pages/MyContractsPage'));
const MyPaymentsPage = React.lazy(() => import('./pages/MyPaymentsPage'));
const MyProfilePage = React.lazy(() => import('./pages/MyProfilePage'));
const NotificationsPage = React.lazy(() => import('./pages/NotificationsPage'));
const AdminClientsPage = React.lazy(() => import('./pages/AdminClientsPage'));
const AdminBookingsPage = React.lazy(() => import('./pages/AdminBookingsPage'));
const AdminContractsPage = React.lazy(() => import('./pages/AdminContractsPage'));
const AdminContractDetailPage = React.lazy(() => import('./pages/AdminContractDetailPage'));
const AdminTodayPage = React.lazy(() => import('./pages/AdminTodayPage'));
const AdminFinancePage = React.lazy(() => import('./pages/AdminFinancePage'));
const AdminCouponsPage = React.lazy(() => import('./pages/AdminCouponsPage'));
const AdminReportsPage = React.lazy(() => import('./pages/AdminReportsPage'));
const AdminSettingsPage = React.lazy(() => import('./pages/AdminSettingsPage'));
const AdminNotificationsPage = React.lazy(() => import('./pages/AdminNotificationsPage'));
const ClientProfilePage = React.lazy(() => import('./pages/ClientProfilePage'));

// Preload the page chunks while the browser is idle so navigation is instant
// (avoids the first-visit "download the chunk" delay / flicker).
let pagesPreloaded = false;
function preloadPages() {
    if (pagesPreloaded) return;
    pagesPreloaded = true;
    const loaders = [
        () => import('./pages/DashboardPage'),
        () => import('./pages/CalendarPage'),
        () => import('./pages/MyBookingsPage'),
        () => import('./pages/MyContractsPage'),
        () => import('./pages/MyPaymentsPage'),
        () => import('./pages/MyProfilePage'),
        () => import('./pages/NotificationsPage'),
        () => import('./pages/AdminTodayPage'),
        () => import('./pages/AdminBookingsPage'),
        () => import('./pages/AdminClientsPage'),
        () => import('./pages/AdminContractsPage'),
        () => import('./pages/AdminContractDetailPage'),
        () => import('./pages/AdminFinancePage'),
        () => import('./pages/AdminCouponsPage'),
        () => import('./pages/AdminReportsPage'),
        () => import('./pages/AdminSettingsPage'),
        () => import('./pages/AdminNotificationsPage'),
        () => import('./pages/ClientProfilePage'),
    ];
    // Stagger so we don't compete with the initial render's network/CPU.
    loaders.forEach((load, i) => setTimeout(() => { load().catch(() => {}); }, i * 120));
}

// ─── Layout ─────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
    usePushSubscription();
    const location = useLocation();
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
            <Topbar onToggleSidebar={toggleSidebar} />
            <Sidebar collapsed={sidebarCollapsed} />

            <main className="main-content">
                {/* Barreira por página: um crash na tela mantém o shell (sidebar/topbar)
                    vivo. key={pathname} REMONTA a barreira ao navegar — sem isso o
                    fallback ficava preso mesmo trocando de página pela sidebar. */}
                <ErrorBoundary key={location.pathname}>
                    <Suspense fallback={<PageTransitionLoader />}>
                        {children}
                    </Suspense>
                </ErrorBoundary>
            </main>

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

    // Load payment methods + preload page chunks (on idle) once authenticated,
    // so navigating between tabs is instant instead of downloading on first click.
    useEffect(() => {
        if (!user) return;
        loadPaymentMethods();
        const ric: (cb: () => void) => void =
            (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
            || ((cb) => window.setTimeout(cb, 1500));
        ric(() => preloadPages());
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
            {/* Logged-in users (incl. installed PWA launching at start_url '/') go straight to the app. */}
            <Route path="/" element={user ? <Navigate to="/dashboard" replace /> : <LandingPage />} />
            <Route path="/login" element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />} />
            <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
            <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
            <Route path="/minhas-gravacoes" element={<ProtectedRoute><MyBookingsPage /></ProtectedRoute>} />
            <Route path="/meus-resultados" element={<ProtectedRoute><MyResultsPage /></ProtectedRoute>} />
            <Route path="/meus-contratos" element={<ProtectedRoute><MyContractsPage /></ProtectedRoute>} />
            <Route path="/meus-pagamentos" element={<ProtectedRoute><MyPaymentsPage /></ProtectedRoute>} />
            <Route path="/perfil" element={<ProtectedRoute><MyProfilePage /></ProtectedRoute>} />
            <Route path="/notificacoes" element={<ProtectedRoute><NotificationsPage /></ProtectedRoute>} />

            {/* Admin routes */}
            <Route path="/admin/today" element={<ProtectedRoute><AdminRoute><AdminTodayPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/bookings" element={<ProtectedRoute><AdminRoute><AdminBookingsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/clients" element={<ProtectedRoute><AdminRoute><AdminClientsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/clients/:id" element={<ProtectedRoute><AdminRoute><ClientProfilePage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/contracts" element={<ProtectedRoute><AdminRoute><AdminContractsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/contracts/:id" element={<ProtectedRoute><AdminRoute><AdminContractDetailPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/finance" element={<ProtectedRoute><AdminRoute><AdminFinancePage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/cupons" element={<ProtectedRoute><AdminRoute><AdminCouponsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/reports" element={<ProtectedRoute><AdminRoute><AdminReportsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/configuracoes" element={<ProtectedRoute><AdminRoute><AdminSettingsPage /></AdminRoute></ProtectedRoute>} />
            <Route path="/admin/notificacoes" element={<ProtectedRoute><AdminRoute><AdminNotificationsPage /></AdminRoute></ProtectedRoute>} />

            {/* Legacy redirects */}
            {/* Rotas antigas em inglês (R4): bookmarks, atalhos da PWA instalada e
                actionUrls de notificações persistidas continuam funcionando. */}
            <Route path="/my-bookings" element={<Navigate to="/minhas-gravacoes" replace />} />
            <Route path="/my-contracts" element={<Navigate to="/meus-contratos" replace />} />
            <Route path="/clients" element={<Navigate to="/admin/clients" replace />} />
            <Route path="/admin/pricing" element={<Navigate to="/admin/configuracoes?sec=financeiro" replace />} />
            <Route path="/admin/services" element={<Navigate to="/admin/configuracoes?sec=servicos" replace />} />
            <Route path="/admin/integrations" element={<Navigate to="/admin/configuracoes?sec=integracoes" replace />} />

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
                            {/* Barreira global: última linha de defesa contra tela branca */}
                            <ErrorBoundary>
                                <AppRoutes />
                            </ErrorBoundary>
                        </NavigationProvider>
                    </AuthProvider>
                </BrowserRouter>
            </UIProvider>
        </GoogleOAuthProvider>
    );
}
