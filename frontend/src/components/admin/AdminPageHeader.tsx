import { LucideIcon } from 'lucide-react';

interface AdminPageHeaderProps {
    icon: LucideIcon;
    title: string;
    subtitle?: string;
    /** Buttons / controls rendered on the right of the header. */
    actions?: React.ReactNode;
    variant?: 'default' | 'alert';
}

/**
 * Hero header for admin pages — reuses the client area's `.client-hero` design
 * system (client-area.css) so admin matches the polished client look.
 */
export default function AdminPageHeader({ icon: Icon, title, subtitle, actions, variant = 'default' }: AdminPageHeaderProps) {
    return (
        <div className={`client-hero client-hero--${variant} animate-card-enter`}>
            <div className="client-hero__header client-hero__header--standalone">
                <div className="client-hero__icon-wrapper">
                    <Icon size={24} strokeWidth={1.8} />
                </div>
                <div style={{ minWidth: 0 }}>
                    <h1 className="client-hero__title">{title}</h1>
                    {subtitle && <p className="client-hero__subtitle">{subtitle}</p>}
                </div>
                {actions && <div className="client-hero__actions">{actions}</div>}
            </div>
        </div>
    );
}
