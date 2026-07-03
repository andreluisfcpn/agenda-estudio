import { useAuth } from '../context/AuthContext';
import AdminDashboard from '../components/admin/dashboard/AdminDashboard';
import ClientDashboard from '../components/client/ClientDashboard';

export default function DashboardPage() {
    const { user } = useAuth();
    return user?.role === 'ADMIN' ? <AdminDashboard /> : <ClientDashboard />;
}
