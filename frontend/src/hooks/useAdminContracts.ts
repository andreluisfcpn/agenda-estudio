import { useState, useEffect, useCallback } from 'react';
import { contractsApi, usersApi, pricingApi, Contract, UserSummary, PricingConfig } from '../api/client';

export type ContractFilter = 'ALL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION' | 'PAUSED';

export function useAdminContracts() {
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [pricing, setPricing] = useState<PricingConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<ContractFilter>('ALL');
    const [search, setSearch] = useState('');

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const [cRes, uRes, pRes] = await Promise.all([contractsApi.getAll(), usersApi.getAll(), pricingApi.get()]);
            setContracts(cRes.contracts);
            setUsers(uRes.users);
            setPricing(pRes.pricing);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    return {
        contracts, setContracts,
        users,
        pricing,
        loading,
        filter, setFilter,
        search, setSearch,
        reload,
    };
}
