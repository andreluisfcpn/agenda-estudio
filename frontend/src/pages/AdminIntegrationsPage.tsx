import React from 'react';
import { Plug } from 'lucide-react';
import AdminPageHeader from '../components/admin/AdminPageHeader';
import IntegrationSettings from '../components/IntegrationSettings';

export default function AdminIntegrationsPage() {
    return (
        <div>
            {/* --- HEADER --- */}
            <AdminPageHeader
                icon={Plug}
                title="Integrações"
                subtitle="Provedores de pagamento (Stripe e Cora)"
            />

            {/* --- INTEGRATION SETTINGS (reused component) --- */}
            <IntegrationSettings />
        </div>
    );
}
