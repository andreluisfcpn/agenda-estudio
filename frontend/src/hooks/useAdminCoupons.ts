import { useState, useEffect, useCallback } from 'react';
import { couponsApi, Coupon } from '../api/client';

export type CouponStatusFilter = 'ALL' | 'ACTIVE' | 'EXPIRED' | 'EXHAUSTED';

export function useAdminCoupons() {
    const [coupons, setCoupons] = useState<Coupon[]>([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState<CouponStatusFilter>('ALL');

    const reload = useCallback(async () => {
        setLoading(true);
        try { const res = await couponsApi.getAll(); setCoupons(res.coupons); } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    return { coupons, setCoupons, loading, statusFilter, setStatusFilter, reload };
}
