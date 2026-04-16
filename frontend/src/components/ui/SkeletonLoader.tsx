import React from 'react';

interface SkeletonProps {
    width?: string | number;
    height?: string | number;
    variant?: 'rect' | 'rounded' | 'circle';
    className?: string;
    style?: React.CSSProperties;
}

function Skeleton({ width = '100%', height = 16, variant = 'rect', className = '', style }: SkeletonProps) {
    const variantClass = variant === 'rounded' ? 'skeleton--rounded' : variant === 'circle' ? 'skeleton--circle' : '';
    return (
        <div
            className={`skeleton ${variantClass} ${className}`}
            style={{ width, height, ...style }}
            aria-hidden="true"
        />
    );
}

/** Skeleton for a StatCard (icon + label + value) */
export function StatCardSkeleton() {
    return (
        <div className="stat-card-ui" style={{ minHeight: 120 }}>
            <Skeleton variant="rounded" width={36} height={36} style={{ marginBottom: 12 }} />
            <Skeleton width={80} height={10} style={{ marginBottom: 8 }} />
            <Skeleton width={120} height={24} style={{ marginBottom: 6 }} />
            <Skeleton width={100} height={12} />
        </div>
    );
}

/** Skeleton for a ContractCard (header + progress bar) */
export function ContractCardSkeleton() {
    return (
        <div className="card" style={{ padding: '20px 24px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3 }}>
                <Skeleton width="100%" height={3} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <Skeleton variant="rounded" width={72} height={22} />
                <Skeleton variant="rounded" width={80} height={22} />
                <Skeleton variant="rounded" width={56} height={22} />
            </div>
            <Skeleton width="60%" height={14} style={{ marginBottom: 8 }} />
            <Skeleton width="45%" height={12} style={{ marginBottom: 16 }} />
            <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Skeleton width={70} height={10} />
                    <Skeleton width={100} height={10} />
                </div>
                <Skeleton variant="rounded" width="100%" height={8} />
                <Skeleton width={120} height={10} style={{ marginTop: 4 }} />
            </div>
        </div>
    );
}

/** Skeleton for a payment history row */
export function PaymentRowSkeleton() {
    return (
        <div className="history-row">
            <div>
                <Skeleton width={140} height={14} style={{ marginBottom: 6 }} />
                <Skeleton width={100} height={11} />
            </div>
            <div style={{ textAlign: 'right' }}>
                <Skeleton width={80} height={14} style={{ marginBottom: 6, marginLeft: 'auto' }} />
                <Skeleton variant="rounded" width={64} height={20} style={{ marginLeft: 'auto' }} />
            </div>
        </div>
    );
}

/** Skeleton for a booking row */
export function BookingRowSkeleton() {
    return (
        <div className="booking-row" style={{ cursor: 'default' }}>
            <div className="booking-row__left">
                <Skeleton width={80} height={14} />
                <Skeleton width={100} height={12} />
            </div>
            <Skeleton variant="rounded" width={64} height={20} />
        </div>
    );
}

/** Full-page loading skeleton for Dashboard */
export function DashboardSkeleton() {
    return (
        <div className="stagger-enter" style={{ display: 'grid', gap: 20 }}>
            {/* Greeting */}
            <div>
                <Skeleton width={200} height={28} style={{ marginBottom: 8 }} />
                <Skeleton width={280} height={16} />
            </div>
            {/* Action buttons */}
            <div style={{ display: 'flex', gap: 12 }}>
                <Skeleton variant="rounded" width={130} height={40} />
                <Skeleton variant="rounded" width={150} height={40} />
            </div>
            {/* Stat cards grid */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                <StatCardSkeleton />
                <StatCardSkeleton />
                <StatCardSkeleton />
                <StatCardSkeleton />
            </div>
            {/* Next sessions */}
            <div>
                <Skeleton width={180} height={20} style={{ marginBottom: 16 }} />
                <div style={{ display: 'grid', gap: 8 }}>
                    <BookingRowSkeleton />
                    <BookingRowSkeleton />
                    <BookingRowSkeleton />
                </div>
            </div>
        </div>
    );
}

/** Full-page loading skeleton for Contracts */
export function ContractsSkeleton() {
    return (
        <div className="stagger-enter" style={{ display: 'grid', gap: 20 }}>
            <Skeleton width={200} height={24} style={{ marginBottom: 4 }} />
            <ContractCardSkeleton />
            <ContractCardSkeleton />
        </div>
    );
}

/** Full-page loading skeleton for Payments */
export function PaymentsSkeleton() {
    return (
        <div className="stagger-enter" style={{ display: 'grid', gap: 20 }}>
            <Skeleton width={200} height={24} style={{ marginBottom: 4 }} />
            {/* Saved card */}
            <Skeleton variant="rounded" width="100%" height={120} />
            {/* Payment history */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <PaymentRowSkeleton />
                <PaymentRowSkeleton />
                <PaymentRowSkeleton />
                <PaymentRowSkeleton />
            </div>
        </div>
    );
}

export default Skeleton;
