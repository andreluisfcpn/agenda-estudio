import { LucideIcon } from 'lucide-react';

interface StatCardProps {
    icon: LucideIcon;
    label: string;
    value: string | number;
    detail?: string;
    accent?: string;
    index?: number;
    onClick?: () => void;
}

export default function StatCard({ icon: Icon, label, value, detail, accent = 'var(--accent-primary)', index = 0, onClick }: StatCardProps) {
    return (
        <div
            className={`stat-card-ui animate-card-enter${onClick ? ' card-interactive' : ''}`}
            style={{ '--i': index, '--accent': accent } as React.CSSProperties}
            onClick={onClick}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
        >
            <div className="stat-card-ui__icon" aria-hidden="true">
                <Icon size={20} strokeWidth={1.8} />
            </div>
            <div className="stat-card-ui__bg-icon" aria-hidden="true">
                <Icon size={48} strokeWidth={1} />
            </div>
            <span className="stat-card-ui__label">{label}</span>
            <span className="stat-card-ui__value">{value}</span>
            {detail && <span className="stat-card-ui__detail">{detail}</span>}
        </div>
    );
}
