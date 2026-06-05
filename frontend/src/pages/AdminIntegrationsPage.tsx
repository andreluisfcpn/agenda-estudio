import React from 'react';
import IntegrationSettings from '../components/IntegrationSettings';

export default function AdminIntegrationsPage() {
    return (
        <div>
            {/* --- HEADER --- */}
            <div style={{
                marginBottom: '28px',
            }}>
                <h1 style={{
                    fontSize: '1.75rem',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    margin: 0,
                }}>
                    🔌 Integrações
                </h1>
                <p style={{
                    color: 'var(--text-muted)',
                    fontSize: '0.9rem',
                    marginTop: '6px',
                }}>
                    Gerencie as integrações com provedores de pagamento (Stripe e Cora)
                </p>
            </div>

            {/* --- INTEGRATION SETTINGS (reused component) --- */}
            <IntegrationSettings />
        </div>
    );
}
