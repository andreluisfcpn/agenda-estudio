import { NavLink } from 'react-router-dom';

export default function AdminNav() {
    return (
        <>
            <div style={{ padding: '14px 12px 6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ height: 1, flex: 1, background: 'rgba(255,255,255,0.06)' }} />
                <span style={{ fontSize: '0.5625rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--text-muted)', fontWeight: 700, whiteSpace: 'nowrap' }}>Administração</span>
                <div style={{ height: 1, flex: 1, background: 'rgba(255,255,255,0.06)' }} />
            </div>

            <NavLink to="/admin/today" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">📍</span>
                <span>Hoje</span>
            </NavLink>

            <NavLink to="/admin/bookings" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">📋</span>
                <span>Agendamentos</span>
            </NavLink>

            <NavLink to="/admin/clients" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">👥</span>
                <span>Clientes</span>
            </NavLink>

            <NavLink to="/admin/contracts" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">📄</span>
                <span>Contratos</span>
            </NavLink>

            <NavLink to="/admin/pricing" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">💰</span>
                <span>Planos & Valores</span>
            </NavLink>

            <NavLink to="/admin/finance" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">💳</span>
                <span>Financeiro</span>
            </NavLink>

            <NavLink to="/admin/reports" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="icon">📈</span>
                <span>Relatórios</span>
            </NavLink>
        </>
    );
}
