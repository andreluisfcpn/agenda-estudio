import { useState, useEffect, useCallback } from 'react';
import { usersApi, UserSummary } from '../api/client';

export type ClientTypeFilter = 'ALL' | 'ACTIVE' | 'EX_CLIENT' | 'NO_CONTRACT' | 'NO_ADDON';

export function useAdminClients() {
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState<ClientTypeFilter>('ALL');

    const reload = useCallback(async () => {
        setLoading(true);
        try { const res = await usersApi.getAll(); setUsers(res.users); } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    return { users, setUsers, loading, search, setSearch, typeFilter, setTypeFilter, reload };
}
