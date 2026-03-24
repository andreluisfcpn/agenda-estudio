const API_BASE = '/api';

export class ApiError extends Error {
    status: number;
    details?: any;

    constructor(message: string, status: number, details?: any) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.details = details;
    }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body.details);
    }
    return res.json();
}


// ─── Auth ───────────────────────────────────────────────
export const authApi = {
    login: (email: string, password: string) => request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    register: (data: { email: string; password: string; name: string; phone?: string; method?: 'email' | 'phone'; code?: string; }) => request<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    googleLogin: (idToken: string) => request<{ user: User }>('/auth/google', { method: 'POST', body: JSON.stringify({ idToken }) }),
    sendRegistrationCode: (data: { phone: string, email: string, password: string, name: string, method: 'email' | 'phone' }) => request<{ message: string }>('/auth/register/send-code', { method: 'POST', body: JSON.stringify(data) }),
    sendOtp: (phone: string, email: string, password: string, name?: string) => request<{ message: string }>('/auth/otp/send', { method: 'POST', body: JSON.stringify({ phone, email, password, name }) }),
    verifyOtp: (phone: string, code: string, email: string, password: string, name?: string) => request<{ user: User }>('/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone, code, email, password, name }) }),
    me: () => request<{ user: User }>('/auth/me'),

    refresh: () => request<{ message: string }>('/auth/refresh', { method: 'POST' }),
    logout: () => request<{ message: string }>('/auth/logout', { method: 'POST' }),
    updateProfile: (data: { name?: string; phone?: string; password?: string }) => request<{ user: User; message: string }>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
    uploadPhoto: async (file: File): Promise<{ user: User; message: string }> => {
        const formData = new FormData();
        formData.append('photo', file);
        const res = await fetch(`${API_BASE}/auth/profile/photo`, {
            method: 'POST', credentials: 'include', body: formData,
        });
        if (!res.ok) { const body = await res.json().catch(() => ({ error: 'Erro' })); throw new Error(body.error); }
        return res.json();
    },
};

// ─── Bookings ───────────────────────────────────────────
export const bookingsApi = {
    getAvailability: (date: string) => request<{ date: string; dayOfWeek: number; closed: boolean; slots: Slot[]; myBookings: MyBookingSlot[] }>(`/bookings/availability?date=${date}`),
    create: (data: { date: string; startTime: string; contractId?: string; addOns?: string[] }) => request<{ booking: Booking; lockExpiresIn: number; message: string }>('/bookings', { method: 'POST', body: JSON.stringify(data) }),
    createBulk: (data: { contractId: string; slots: { date: string; startTime: string }[] }) => request<{ message: string }>('/bookings/bulk', { method: 'POST', body: JSON.stringify(data) }),
    adminCreate: (data: { userId: string; date: string; startTime: string; status?: string; addOns?: string[] }) => request<{ booking: Booking; message: string }>('/bookings/admin', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { date?: string; startTime?: string; status?: string; adminNotes?: string; clientNotes?: string; platforms?: string; platformLinks?: string, durationMinutes?: number | null, peakViewers?: number | null, chatMessages?: number | null, audienceOrigin?: string | null }) => request<{ booking: BookingWithUser; message: string }>(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    confirm: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/confirm`, { method: 'PATCH' }),
    cancel: (id: string) => request<{ message: string }>(`/bookings/${id}`, { method: 'DELETE' }),
    getMy: () => request<{ bookings: Booking[] }>('/bookings/my'),
    getAll: (date?: string, status?: string) => {
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        if (status) params.set('status', status);
        const qs = params.toString();
        return request<{ bookings: BookingWithUser[] }>(`/bookings${qs ? `?${qs}` : ''}`);
    },
    clientUpdate: (id: string, data: { clientNotes?: string; platforms?: string; platformLinks?: string }) =>
        request<{ booking: Booking; message: string }>(`/bookings/${id}/client-update`, { method: 'PATCH', body: JSON.stringify(data) }),
    reschedule: (id: string, data: { date: string; startTime: string }) =>
        request<{ booking: Booking; message: string }>(`/bookings/${id}/reschedule`, { method: 'PATCH', body: JSON.stringify(data) }),
    purchaseAddon: (id: string, addonKey: string) =>
        request<{ booking: Booking; checkoutUrl: string; message: string; amount: number }>(`/bookings/${id}/addons`, { method: 'POST', body: JSON.stringify({ addonKey }) }),
};

// ─── Contracts ──────────────────────────────────────────
export const contractsApi = {
    checkFixo: (data: { tier: string; durationMonths: number; startDate: string; fixedDayOfWeek: number; fixedTime: string }) =>
        request<{ available: boolean; conflicts: { date: string; originalTime: string; suggestedReplacement?: { date: string; time: string } }[] }>('/contracts/check-fixo', { method: 'POST', body: JSON.stringify(data) }),
    create: (data: CreateContractData) => request<{ contract: Contract; payments: PaymentSummary[]; message: string }>('/contracts', { method: 'POST', body: JSON.stringify(data) }),
    createSelf: (data: SelfContractData) => request<{ contract: Contract; message: string }>('/contracts/self', { method: 'POST', body: JSON.stringify(data) }),    // Standalone services (e.g. Social Media Management)
    createService: (opts: { serviceKey: string, paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO', durationMonths?: number }) => request<{ contract: Contract; checkoutUrl?: string; message: string }>('/contracts/service', { method: 'POST', body: JSON.stringify(opts) }),
    getAll: () => request<{ contracts: Contract[] }>('/contracts'),
    getMy: () => request<{ contracts: ContractWithStats[] }>('/contracts/my'),
    getById: (id: string) => request<{ contract: ContractDetail }>(`/contracts/${id}`),
    update: (id: string, data: { status?: string; endDate?: string; flexCreditsRemaining?: number; contractUrl?: string; paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO' }) => request<{ contract: Contract; message: string }>(`/contracts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    cancel: (id: string) => request<{ message: string }>(`/contracts/${id}`, { method: 'DELETE' }),
    requestCancellation: (id: string) => request<{ contract: Contract; message: string }>(`/contracts/${id}/request-cancellation`, { method: 'POST' }),
    resolveCancellation: (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => request<{ contract: Contract; message: string }>(`/contracts/${id}/resolve-cancellation`, { method: 'POST', body: JSON.stringify({ action }) }),
};

// ─── Users ──────────────────────────────────────────────
export const usersApi = {
    getAll: (role?: string) => request<{ users: UserSummary[] }>(`/users${role ? `?role=${role}` : ''}`),
    getById: (id: string) => request<{ user: UserDetail }>(`/users/${id}`),
    create: (data: { email: string; password: string; name: string; phone?: string; role?: string }) => request<{ user: UserSummary; message: string }>('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; email?: string; phone?: string; role?: string; password?: string; notes?: string }) => request<{ user: UserSummary; message: string }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: string) => request<{ message: string }>(`/users/${id}`, { method: 'DELETE' }),
};

// ─── Blocked Slots ──────────────────────────────────────
export const blockedSlotsApi = {
    create: (data: { date: string; startTime: string; endTime: string; reason?: string }) => request<{ blockedSlot: BlockedSlot; message: string }>('/blocked-slots', { method: 'POST', body: JSON.stringify(data) }),
    getAll: (date?: string) => request<{ blockedSlots: BlockedSlot[] }>(`/blocked-slots${date ? `?date=${date}` : ''}`),
    remove: (id: string) => request<{ message: string }>(`/blocked-slots/${id}`, { method: 'DELETE' }),
};

// ─── Pricing ────────────────────────────────────────────
export const pricingApi = {
    get: () => request<{ pricing: PricingConfig[] }>('/pricing'),
    update: (pricing: PricingConfig[]) => request<{ pricing: PricingConfig[]; message: string }>('/pricing', { method: 'PUT', body: JSON.stringify({ pricing }) }),
    getAddons: () => request<{ addons: AddOnConfig[] }>('/pricing/addons'),
    updateAddons: (addons: AddOnConfig[]) => request<{ addons: AddOnConfig[]; message: string }>('/pricing/addons', { method: 'PUT', body: JSON.stringify({ addons }) }),
};

// ─── Public (No Auth) ───────────────────────────────────
export const publicApi = {
    getWeekAvailability: (startDate: string, days: number = 7) =>
        request<PublicWeekResponse>(`/bookings/public-availability?startDate=${startDate}&days=${days}`),
};

// ─── Types ──────────────────────────────────────────────
export interface User {
    id: string; email: string; name: string; role: 'ADMIN' | 'CLIENTE'; phone?: string | null; photoUrl?: string | null;
}
export interface Slot {
    time: string; available: boolean; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO' | null; price: number | null;
}
export interface Booking {
    id: string; date: string; startTime: string; endTime: string;
    status: 'RESERVED' | 'CONFIRMED' | 'COMPLETED' | 'FALTA' | 'NAO_REALIZADO' | 'CANCELLED';
    tierApplied: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    price: number; contractId?: string | null; userId?: string | null;
    adminNotes?: string | null;
    clientNotes?: string | null;
    platforms?: string;
    platformLinks?: string;
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    addOns?: string[];
    contract?: {
        id: string;
        name: string;
        type: 'FIXO' | 'FLEX' | 'AVULSO' | 'SERVICO';
        tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    } | null;
    paymentIntentId?: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface MyBookingSlot {
    id: string; startTime: string; endTime: string;
    status: 'RESERVED' | 'CONFIRMED' | 'COMPLETED' | 'FALTA' | 'NAO_REALIZADO';
    tierApplied: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    price: number; contractId?: string | null;
    adminNotes?: string | null; clientNotes?: string | null;
    platforms?: string | null; platformLinks?: string | null;
    addOns?: string[];
}
export interface BookingWithUser extends Booking {
    user: { id: string; name: string; email: string; role: string };
}
export interface Contract {
    id: string; name: string; type: 'FIXO' | 'FLEX' | 'SERVICO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: number; discountPct: number; startDate: string; endDate: string;
    status: 'ACTIVE' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION';
    fixedDayOfWeek?: number | null; fixedTime?: string | null;
    contractUrl?: string | null;
    flexCreditsTotal?: number | null; flexCreditsRemaining?: number | null;
    paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO' | null;
    addOns?: string[];
    user?: { id: string; name: string; email: string };
}
export interface ContractWithStats extends Contract {
    completedBookings: number;
    totalBookings: number;
    _count: { bookings: number };
    payments: PaymentSummary[];
    bookings: ContractBooking[];
}
export interface ContractBooking {
    id: string; status: string; date: string;
    startTime: string; endTime: string; tierApplied: string; price: number;
    clientNotes?: string | null; adminNotes?: string | null;
    platforms?: string | null; platformLinks?: string | null;
    durationMinutes?: number | null;
    peakViewers?: number | null;
    chatMessages?: number | null;
    audienceOrigin?: string | null;
    addOns?: string[];
}
export interface ContractDetail extends Contract { bookings: Booking[]; payments: PaymentSummary[]; }
export interface CreateContractData {
    userId: string; name: string; type: 'FIXO' | 'FLEX' | 'SERVICO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: 3 | 6; startDate: string;
    fixedDayOfWeek?: number; fixedTime?: string; contractUrl?: string;
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
}
export interface SelfContractData {
    name: string; type: 'FIXO' | 'FLEX' | 'SERVICO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: 3 | 6;
    firstBookingDate: string; firstBookingTime: string;
    fixedDayOfWeek?: number; fixedTime?: string;
    paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO';
    addOns?: string[];
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
}
export interface PaymentSummary { id: string; amount: number; dueDate: string; status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED'; }
export interface UserSummary {
    id: string; email: string; name: string; phone: string | null; role: string;
    createdAt: string; _count: { bookings: number; contracts: number };
    contracts?: { type: 'FIXO' | 'FLEX' | 'SERVICO' }[];
}
export interface UserDetail {
    id: string; email: string; name: string; phone: string | null; role: string;
    notes: string | null; createdAt: string;
    contracts: Contract[]; bookings: Booking[];
}
export interface BlockedSlot { id: string; date: string; startTime: string; endTime: string; reason: string | null; creator?: { name: string }; }
export interface PricingConfig { tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO'; price: number; label: string; description?: string | null; }
export interface AddOnConfig { key: string; name: string; price: number; description?: string | null; }

// Public types (no auth)
export interface PublicSlot { time: string; available: boolean; tier: string | null; }
export interface PublicDayAvailability { date: string; dayOfWeek: number; closed: boolean; slots: PublicSlot[]; }
export interface PublicWeekResponse { days: PublicDayAvailability[]; }
