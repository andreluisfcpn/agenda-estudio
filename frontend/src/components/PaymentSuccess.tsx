import { CheckCircle2 } from 'lucide-react';

interface PaymentSuccessProps {
    title?: string;
    subtitle?: React.ReactNode;
    /** Extra details rendered below the subtitle. */
    children?: React.ReactNode;
}

/**
 * Unified payment/booking success state — design-token styled (lucide check in a
 * soft green halo), replacing the ad-hoc emoji success screens so confirmations
 * look coherent with the rest of the system.
 */
export default function PaymentSuccess({ title = 'Pagamento confirmado!', subtitle, children }: PaymentSuccessProps) {
    return (
        <div style={{ textAlign: 'center', padding: '12px 4px 4px' }}>
            <div style={{
                width: 72, height: 72, borderRadius: '50%', margin: '0 auto 18px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(16,185,129,0.14)', color: '#10b981',
                boxShadow: '0 0 0 8px rgba(16,185,129,0.06)',
            }}>
                <CheckCircle2 size={40} strokeWidth={2} />
            </div>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 800, margin: '0 0 6px', color: 'var(--text-primary)' }}>{title}</h2>
            {subtitle && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{subtitle}</p>
            )}
            {children}
        </div>
    );
}
