import { useState, useEffect, useCallback } from 'react';
import { bookingsApi, usersApi, BookingWithUser, UserSummary } from '../api/client';

export function useAdminBookings() {
    const [bookings, setBookings] = useState<BookingWithUser[]>([]);
    const [users, setUsers] = useState<UserSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [dateFilter, setDateFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const [bRes, uRes] = await Promise.all([
                bookingsApi.getAll(dateFilter || undefined, statusFilter || undefined),
                usersApi.getAll(),
            ]);
            setBookings(bRes.bookings);
            setUsers(uRes.users);
        } catch (err) { console.error(err); }
        finally { setLoading(false); }
    }, [dateFilter, statusFilter]);

    useEffect(() => { reload(); }, [reload]);

    return { bookings, setBookings, users, loading, dateFilter, setDateFilter, statusFilter, setStatusFilter, reload };
}
