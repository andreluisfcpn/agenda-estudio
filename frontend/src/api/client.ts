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

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
    // Deduplicate: all callers share the same in-flight refresh
    if (refreshPromise) return refreshPromise;

    refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
    })
        .then(r => r.ok)
        .catch(() => false)
        .finally(() => { refreshPromise = null; });

    return refreshPromise;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const doFetch = () =>
        fetch(`${API_BASE}${path}`, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options,
        });

    let res = await doFetch();

    // Auto-refresh on 401 (skip auth endpoints to avoid infinite loop)
    const isAuthEndpoint = path.includes('/auth/refresh') || path.includes('/auth/login');
    if (res.status === 401 && !isAuthEndpoint) {
        const refreshed = await tryRefresh();
        if (refreshed) {
            // Retry the original request with the new access token
            res = await doFetch();
        }
    }

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
    updateProfile: (data: { name?: string; phone?: string; password?: string; cpfCnpj?: string; address?: string; city?: string; state?: string; socialLinks?: any }) => request<{ user: User; message: string }>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
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
    create: (data: { date: string; startTime: string; contractId?: string; addOns?: string[]; paymentMethod?: 'CARTAO' | 'PIX'; installments?: number; paymentType?: 'CREDIT' | 'DEBIT' }) => request<{ booking: Booking & { holdExpiresAt?: string | null }; paymentId?: string | null; clientSecret?: string | null; lockExpiresIn: number; message: string }>('/bookings', { method: 'POST', body: JSON.stringify(data) }),
    completePayment: (id: string, data: { paymentIntentId?: string }) => request<{ booking: Booking; message: string }>(`/bookings/${id}/complete-payment`, { method: 'POST', body: JSON.stringify(data) }),
    createBulk: (data: { contractId: string; slots: { date: string; startTime: string }[] }) => request<{ message: string }>('/bookings/bulk', { method: 'POST', body: JSON.stringify(data) }),
    adminCreate: (data: { userId: string; date: string; startTime: string; status?: string; addOns?: string[]; adminNotes?: string; customPrice?: number }) => request<{ booking: Booking; message: string }>('/bookings/admin', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { date?: string; startTime?: string; status?: string; adminNotes?: string; clientNotes?: string; platforms?: string; platformLinks?: string, durationMinutes?: number | null, peakViewers?: number | null, chatMessages?: number | null, audienceOrigin?: string | null }) => request<{ booking: BookingWithUser; message: string }>(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    confirm: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/confirm`, { method: 'PATCH' }),
    cancel: (id: string) => request<{ message: string }>(`/bookings/${id}`, { method: 'DELETE' }),
    hardDelete: (id: string) => request<{ message: string; creditRestored: boolean }>(`/bookings/${id}/hard-delete`, { method: 'DELETE' }),
    clientCancel: (id: string) => request<{ message: string }>(`/bookings/${id}/client-cancel`, { method: 'PUT' }),
    checkIn: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/check-in`, { method: 'PUT' }),
    complete: (id: string, metrics?: { durationMinutes?: number; peakViewers?: number; chatMessages?: number }) => request<{ booking: Booking; message: string }>(`/bookings/${id}/complete`, { method: 'PUT', body: JSON.stringify(metrics || {}) }),
    markFalta: (id: string) => request<{ booking: Booking; message: string }>(`/bookings/${id}/mark-falta`, { method: 'PUT' }),
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
    createSelf: (data: SelfContractData) => request<{ contract: Contract; message: string; clientSecret?: string }>('/contracts/self', { method: 'POST', body: JSON.stringify(data) }),    // Standalone services (e.g. Social Media Management)
    createService: (opts: { serviceKey: string, paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO', durationMonths?: number }) => request<{ contract: Contract; checkoutUrl?: string; clientSecret?: string; message: string }>('/contracts/service', { method: 'POST', body: JSON.stringify(opts) }),
    createCustom: (data: CustomContractData) => request<{ contract: Contract; payments: PaymentSummary[]; summary: CustomContractSummary; message: string; clientSecret?: string }>('/contracts/custom', { method: 'POST', body: JSON.stringify(data) }),
    checkCustom: (data: { tier: string; durationMonths: number; schedule: { day: number; time: string }[]; startDate: string }) =>
        request<{ available: boolean; conflicts: CustomConflict[]; totalConflicts: number; totalSessions: number }>('/contracts/custom/check', { method: 'POST', body: JSON.stringify(data) }),
    getAll: () => request<{ contracts: Contract[] }>('/contracts'),
    getMy: () => request<{ contracts: ContractWithStats[] }>('/contracts/my'),
    getById: (id: string) => request<{ contract: ContractDetail }>(`/contracts/${id}`),
    update: (id: string, data: { status?: string; endDate?: string; flexCreditsRemaining?: number; contractUrl?: string; paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO' }) => request<{ contract: Contract; message: string }>(`/contracts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    cancel: (id: string) => request<{ message: string }>(`/contracts/${id}`, { method: 'DELETE' }),
    requestCancellation: (id: string) => request<{ contract: Contract; message: string }>(`/contracts/${id}/request-cancellation`, { method: 'POST' }),
    resolveCancellation: (id: string, action: 'CHARGE_FEE' | 'WAIVE_FEE') => request<{ contract: Contract; message: string }>(`/contracts/${id}/resolve-cancellation`, { method: 'POST', body: JSON.stringify({ action }) }),
    renew: (id: string, data?: { durationMonths?: number; tier?: string; type?: string; startDate?: string }) => request<{ contract: Contract; message: string }>(`/contracts/${id}/renew`, { method: 'POST', body: JSON.stringify(data || {}) }),
    clientRenew: (id: string, data: { durationMonths: number; paymentMethod?: 'PIX' | 'CARTAO' | 'BOLETO'; installments?: number }) => request<{ contract: Contract; message: string }>(`/contracts/${id}/client-renew`, { method: 'POST', body: JSON.stringify(data) }),
    subscribe: (id: string, data: { paymentMethodId: string; durationMonths?: number }) => request<{ success: boolean; subscriptionId: string; status: string; message: string }>(`/contracts/${id}/subscribe`, { method: 'POST', body: JSON.stringify(data) }),
    pay: (id: string, data?: { paymentMethod?: 'CARTAO' | 'PIX'; paymentType?: 'CREDIT' | 'DEBIT'; installments?: number }) => request<{ provider?: 'STRIPE' | 'CORA'; clientSecret?: string; paymentId: string; amount: number; maxInstallments?: number; pixString?: string; qrCodeBase64?: string; message: string }>(`/contracts/${id}/pay`, { method: 'POST', body: JSON.stringify(data || {}) }),
    confirmPayment: (id: string, data: { paymentIntentId?: string }) => request<{ contract: { id: string; status: string }; message: string }>(`/contracts/${id}/confirm-payment`, { method: 'POST', body: JSON.stringify(data) }),
    pause: (id: string, data?: { reason?: string; resumeDate?: string }) => request<{ contract: Contract; message: string }>(`/contracts/${id}/pause`, { method: 'PATCH', body: JSON.stringify(data || {}) }),
    resume: (id: string) => request<{ contract: Contract; message: string }>(`/contracts/${id}/resume`, { method: 'PATCH' }),
};

// ─── Users ──────────────────────────────────────────────
export const usersApi = {
    getAll: (role?: string) => request<{ users: UserSummary[] }>(`/users${role ? `?role=${role}` : ''}`),
    getById: (id: string) => request<{ user: UserDetail }>(`/users/${id}`),
    create: (data: { email: string; password: string; name: string; phone?: string; role?: string; notes?: string; cpfCnpj?: string | null; tags?: string[]; socialLinks?: string | null; clientStatus?: string }) => request<{ user: UserSummary; message: string }>('/users', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; email?: string; phone?: string; role?: string; password?: string; notes?: string; cpfCnpj?: string | null; address?: string | null; city?: string | null; state?: string | null; tags?: string[]; socialLinks?: string | null; clientStatus?: string }) => request<{ user: UserSummary; message: string }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
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
    getBusinessConfig: () => request<{ configs: BusinessConfigItem[]; grouped: Record<string, BusinessConfigItem[]> }>('/pricing/business-config'),
    updateBusinessConfig: (configs: { key: string; value: string }[]) => request<{ message: string }>('/pricing/business-config', { method: 'PUT', body: JSON.stringify({ configs }) }),
    getBusinessConfigPublic: () => request<{ config: Record<string, string | number> }>('/pricing/business-config/public'),
    getPaymentMethods: () => request<{ methods: PaymentMethodConfigItem[] }>('/pricing/payment-methods'),
    getPaymentMethodsAll: () => request<{ methods: PaymentMethodConfigItem[] }>('/pricing/payment-methods/all'),
    updatePaymentMethods: (methods: PaymentMethodConfigItem[]) => request<{ methods: PaymentMethodConfigItem[]; message: string }>('/pricing/payment-methods', { method: 'PUT', body: JSON.stringify({ methods }) }),
};

// ─── Public (No Auth) ───────────────────────────────────
export const publicApi = {
    getWeekAvailability: (startDate: string, days: number = 7) =>
        request<PublicWeekResponse>(`/bookings/public-availability?startDate=${startDate}&days=${days}`),
};

// ─── Types ──────────────────────────────────────────────
export interface User {
    id: string; email: string; name: string; role: 'ADMIN' | 'CLIENTE'; phone?: string | null; photoUrl?: string | null;
    cpfCnpj?: string | null; address?: string | null; city?: string | null; state?: string | null; socialLinks?: string | null;
}
export interface Slot {
    time: string; available: boolean; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO' | null; price: number | null;
}
export interface Booking {
    id: string; date: string; startTime: string; endTime: string;
    status: 'RESERVED' | 'CONFIRMED' | 'HELD' | 'COMPLETED' | 'FALTA' | 'NAO_REALIZADO' | 'CANCELLED';
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
    holdExpiresAt?: string | null;
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
    status: 'RESERVED' | 'CONFIRMED' | 'HELD' | 'COMPLETED' | 'FALTA' | 'NAO_REALIZADO';
    tierApplied: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    price: number; contractId?: string | null;
    adminNotes?: string | null; clientNotes?: string | null;
    platforms?: string | null; platformLinks?: string | null;
    addOns?: string[];
    holdExpiresAt?: string | null;
}
export interface BookingWithUser extends Booking {
    user: { id: string; name: string; email: string; role: string };
}
export interface Contract {
    id: string; name: string; type: 'FIXO' | 'FLEX' | 'SERVICO' | 'CUSTOM' | 'AVULSO'; tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: number; discountPct: number; startDate: string; endDate: string;
    status: 'ACTIVE' | 'AWAITING_PAYMENT' | 'EXPIRED' | 'CANCELLED' | 'PENDING_CANCELLATION' | 'PAUSED';
    fixedDayOfWeek?: number | null; fixedTime?: string | null;
    contractUrl?: string | null;
    flexCreditsTotal?: number | null; flexCreditsRemaining?: number | null;
    paymentMethod?: 'CARTAO' | 'PIX' | 'BOLETO' | null;
    paymentDeadline?: string | null;
    addOns?: string[];
    user?: { id: string; name: string; email: string };
    pausedAt?: string | null;
    pauseReason?: string | null;
    resumeDate?: string | null;
    // Custom-specific
    customSchedule?: { day: number; time: string }[] | string | null;
    sessionsPerWeek?: number | null;
    sessionsPerCycle?: number | null;
    totalSessions?: number | null;
    addonCredits?: string | null;
    accessMode?: 'FULL' | 'PROGRESSIVE' | null;
    customCreditsRemaining?: number | null;
    addonUsage?: Record<string, { limit: number, used: number }>;
}
export interface PaymentSummary {
    id: string; amount: number; status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';
    dueDate: string; paidAt?: string; provider?: string;
    pixString?: string | null; boletoUrl?: string | null; paymentUrl?: string | null;
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
export interface CustomContractData {
    name: string;
    tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO';
    durationMonths: number;
    schedule: { day: number; time: string }[];
    paymentMethod: 'CARTAO' | 'PIX' | 'BOLETO';
    addOns?: string[];
    addonConfig?: Record<string, { mode: 'all' | 'credits'; perCycle?: number }>;
    resolvedConflicts?: { originalDate: string; originalTime: string; newDate: string; newTime: string }[];
    startDate?: string;
    userId?: string; // Admin-only: create on behalf of a client
    frequency?: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
    weekPattern?: number[];
    customDates?: { date: string; time: string }[];
}
export interface CustomContractSummary {
    sessionsPerWeek: number; sessionsPerCycle: number; totalSessions: number;
    discountPct: number; accessMode: string; cycleAmount: number; totalBookingsGenerated: number;
}
export interface CustomConflict {
    date: string; originalTime: string; day: number;
    suggestedReplacement?: { date: string; time: string };
}
// PaymentSummary is defined above (line ~247) — removed duplicate here
export interface UserSummary {
    id: string; email: string; name: string; phone: string | null; role: string;
    clientStatus: string; tags: string[];
    createdAt: string; _count: { bookings: number; contracts: number };
    contracts?: { type: 'FIXO' | 'FLEX' | 'SERVICO' | 'CUSTOM' | 'AVULSO'; status: string; addOns: string[] }[];
    totalPaid: number; totalPending: number;
}
export interface UserDetail {
    id: string; email: string; name: string; phone: string | null; role: string;
    notes: string | null; photoUrl: string | null;
    cpfCnpj: string | null; address: string | null; city: string | null; state: string | null;
    tags: string[]; socialLinks: string | null; clientStatus: string;
    createdAt: string;
    contracts: Contract[]; bookings: Booking[];
    payments?: { id: string; amount: number; status: string; dueDate: string | null; createdAt: string }[];
}
export interface BlockedSlot { id: string; date: string; startTime: string; endTime: string; reason: string | null; creator?: { name: string }; }
export interface PricingConfig { tier: 'COMERCIAL' | 'AUDIENCIA' | 'SABADO'; price: number; label: string; description?: string | null; }
export interface AddOnConfig { key: string; name: string; price: number; description?: string | null; monthly?: boolean; }
export interface BusinessConfigItem { key: string; value: string; type: string; label: string; group: string; }
export interface PaymentMethodConfigItem {
    key: string; label: string; shortLabel: string; emoji: string;
    description: string; color: string; active: boolean;
    sortOrder: number; accessMode: string;
}

// Public types (no auth)
export interface PublicSlot { time: string; available: boolean; tier: string | null; }
export interface PublicDayAvailability { date: string; dayOfWeek: number; closed: boolean; slots: PublicSlot[]; }
export interface PublicWeekResponse { days: PublicDayAvailability[]; }

// ─── Payments (Financial) ───────────────────────────────
export interface PaymentFull {
    id: string;
    userId: string;
    contractId: string | null;
    bookingId: string | null;
    provider: string;
    providerRef: string | null;
    amount: number;
    status: 'PENDING' | 'PAID' | 'FAILED' | 'REFUNDED';
    dueDate: string | null;
    createdAt: string;
    updatedAt: string;
    user: { id: string; name: string; email: string };
    contract: { id: string; name: string; type: string; tier: string; durationMonths: number } | null;
    booking: { id: string; date: string; startTime: string } | null;
}
export interface FinancialSummary {
    totalRevenue: number; paidRevenue: number; pendingRevenue: number;
    overdueCount: number; overdueAmount: number;
    failedCount: number; refundedAmount: number;
    totalCount: number; paidCount: number; pendingCount: number;
}
export interface MonthlyBreakdown {
    month: string; label: string; total: number; paid: number; pending: number;
}
export const paymentsApi = {
    getAll: (params?: { status?: string; userId?: string; from?: string; to?: string; search?: string }) => {
        const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString() : '';
        return request<{ payments: PaymentFull[] }>(`/payments${qs}`);
    },
    getSummary: (params?: { from?: string; to?: string }) => {
        const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString() : '';
        return request<{ summary: FinancialSummary; monthlyBreakdown: MonthlyBreakdown[] }>(`/payments/summary${qs}`);
    },
    update: (id: string, data: { status?: string; providerRef?: string }) =>
        request<{ payment: PaymentFull; message: string }>(`/payments/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    getStatus: (paymentId: string) =>
        request<{ status: string; provider: string; pixString?: string; boletoUrl?: string }>(`/payments/${paymentId}/status`),
};

// ─── Notifications ──────────────────────────────────────
export interface NotificationItem {
    id: string;
    type: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    message: string;
    entityType: string;
    entityId: string;
    actionUrl?: string;
    createdAt: string;
}
export interface NotificationSummary {
    total: number; critical: number; warning: number; info: number;
}
export const notificationsApi = {
    getAll: () => request<{ notifications: NotificationItem[]; summary: NotificationSummary }>('/notifications'),
};

// ─── Reports ────────────────────────────────────────────
export interface ReportSummary {
    totalBookings: number; completedBookings: number; faltaBookings: number;
    cancelledBookings: number; totalRevenue: number;
    attendanceRate: number; cancellationRate: number;
}
export interface SlotOccupancy { slot: string; label: string; count: number; total: number; pct: number; }
export interface DayOccupancy { day: string; count: number; total: number; pct: number; }
export interface TierBreakdownItem { tier: string; count: number; revenue: number; pct: number; }
export interface AudienceMetrics { totalCompleted: number; avgViewers: number; maxViewers: number; avgChat: number; avgDuration: number; }
export interface ClientRankItem { name: string; id: string; sessions: number; revenue: number; completed: number; falta: number; avgViewers: number; }

export const reportsApi = {
    getSummary: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ summary: ReportSummary }>(`/reports/summary${qs}`);
    },
    getOccupancy: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ slotOccupancy: SlotOccupancy[]; dayOccupancy: DayOccupancy[] }>(`/reports/occupancy${qs}`);
    },
    getTiers: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ tierBreakdown: TierBreakdownItem[] }>(`/reports/tiers${qs}`);
    },
    getAudience: (params?: { from?: string; to?: string }) => {
        const qs = buildQS(params);
        return request<{ audience: AudienceMetrics }>(`/reports/audience${qs}`);
    },
    getRanking: (params?: { from?: string; to?: string; limit?: number }) => {
        const qs = buildQS(params as Record<string, string | number | undefined>);
        return request<{ ranking: ClientRankItem[] }>(`/reports/ranking${qs}`);
    },
};

export interface FinanceMetrics {
    grossRevenue: number;
    netRevenue: number;
    totalFees: number;
    pendingRevenue: number;
    paidCount: number;
    unpaidCount: number;
    breakdown: { stripe: number; cora: number; };
}

export interface EnrichedPayment extends PaymentSummary {
    createdAt: string;
    methodLabel: string;
    methodEmoji: string;
    feeDeduced: number;
    netAmount: number;
    user?: { id: string; name: string; email: string; };
    contract?: { id: string; name: string; type: string; tier: string; paymentMethod: string; };
}

export interface FinanceClosingResponse {
    period: { year: number; month: number; };
    metrics: FinanceMetrics;
    payments: EnrichedPayment[];
}

export const financeApi = {
    getMonthlyClosing: (year: number, month: number) => request<FinanceClosingResponse>(`/finance/closing/${year}/${month}`),
};

// ─── Integrations API ────────────────────────────────────

export interface IntegrationSummary {
    provider: string;
    enabled: boolean;
    environment: string;
    config: Record<string, any>;
    configured: boolean;
    webhookUrl: string | null;
    lastTestedAt: string | null;
    testStatus: 'success' | 'error' | null;
    testMessage: string | null;
}

export const integrationsApi = {
    list: () => request<{ integrations: IntegrationSummary[] }>('/integrations'),
    get: (provider: string) => request<{ integration: IntegrationSummary }>(`/integrations/${provider}`),
    save: (provider: string, data: { environment: string; enabled?: boolean; config: Record<string, any> }) =>
        request<{ integration: IntegrationSummary; message: string }>(`/integrations/${provider}`, { method: 'PUT', body: JSON.stringify(data) }),
    test: (provider: string) =>
        request<{ success: boolean; message: string }>(`/integrations/${provider}/test`, { method: 'POST' }),
    toggle: (provider: string, enabled: boolean) =>
        request<{ message: string }>(`/integrations/${provider}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }),
    // Cora webhook management (via Cora API)
    listCoraWebhooks: () =>
        request<{ endpoints: { id: string; url: string; events?: string[]; created_at?: string }[] }>('/integrations/cora/webhooks'),
    registerCoraWebhook: (url: string) =>
        request<{ message: string; endpoint: any }>('/integrations/cora/webhooks', { method: 'POST', body: JSON.stringify({ url }) }),
    deleteCoraWebhook: (id: string) =>
        request<{ message: string }>(`/integrations/cora/webhooks/${id}`, { method: 'DELETE' }),
};

function buildQS(params?: Record<string, string | number | undefined>): string {
    if (!params) return '';
    const entries = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]);
    return entries.length > 0 ? '?' + new URLSearchParams(entries as [string, string][]).toString() : '';
}

// ─── Stripe API (Card Payments) ─────────────────────────

export interface SavedCard {
    id: string;
    stripePaymentMethodId: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    funding: string; // 'credit' | 'debit' | 'prepaid' | 'unknown'
    isDefault: boolean;
}

export interface InstallmentPlan {
    count: number;
    perInstallment: number;
    total: number;
    feePercent: number;
    freeOfCharge: boolean;
}

// Short-lived cache for listPaymentMethods (avoids hitting Stripe on every navigation)
const _pmCache: {
    data: { paymentMethods: SavedCard[]; autoChargeEnabled: boolean } | null;
    promise: Promise<{ paymentMethods: SavedCard[]; autoChargeEnabled: boolean }> | null;
    ts: number;
} = { data: null, promise: null, ts: 0 };
const PM_CACHE_TTL = 30_000; // 30 seconds

function invalidatePmCache() { _pmCache.data = null; _pmCache.promise = null; _pmCache.ts = 0; }

export const stripeApi = {
    getPublishableKey: () => request<{ publishableKey: string }>('/stripe/publishable-key'),
    createSetupIntent: () => request<{ clientSecret: string; setupIntentId: string }>('/stripe/setup-intent', { method: 'POST' }),
    listPaymentMethods: (): Promise<{ paymentMethods: SavedCard[]; autoChargeEnabled: boolean }> => {
        const now = Date.now();
        // Return cached data if still fresh
        if (_pmCache.data && (now - _pmCache.ts) < PM_CACHE_TTL) return Promise.resolve(_pmCache.data);
        // Deduplicate in-flight requests
        if (_pmCache.promise) return _pmCache.promise;
        _pmCache.promise = request<{ paymentMethods: SavedCard[]; autoChargeEnabled: boolean }>('/stripe/payment-methods')
            .then(res => { _pmCache.data = res; _pmCache.ts = Date.now(); _pmCache.promise = null; return res; })
            .catch(err => { _pmCache.promise = null; throw err; });
        return _pmCache.promise;
    },
    invalidateCache: invalidatePmCache,
    removePaymentMethod: (pmId: string) => { invalidatePmCache(); return request<{ message: string }>(`/stripe/payment-methods/${pmId}`, { method: 'DELETE' }); },
    setDefaultPaymentMethod: (pmId: string) => { invalidatePmCache(); return request<{ message: string }>(`/stripe/payment-methods/${pmId}/default`, { method: 'PUT' }); },
    createPayment: (data: { paymentId: string; installments?: number; savedPaymentMethodId?: string; savePaymentMethod?: boolean; paymentMethod?: 'cartao' | 'pix' }) =>
        request<{ provider: 'STRIPE' | 'CORA'; clientSecret?: string; paymentIntentId?: string; pixString?: string; qrCodeBase64?: string; boletoUrl?: string; barcode?: string; paymentId?: string }>('/stripe/create-payment', { method: 'POST', body: JSON.stringify(data) }),
    verifyPayment: (data: { paymentId: string; paymentIntentId: string }) =>
        request<{ status: string; message: string }>('/stripe/verify-payment', { method: 'POST', body: JSON.stringify(data) }),
    getInstallmentPlans: (data: { paymentId?: string; amount?: number; contractDurationMonths?: number }) =>
        request<{ plans: InstallmentPlan[] }>('/stripe/installment-plans', { method: 'POST', body: JSON.stringify(data) }),
    setAutoCharge: (enabled: boolean) => { invalidatePmCache(); return request<{ message: string }>('/stripe/auto-charge', { method: 'PUT', body: JSON.stringify({ enabled }) }); },
};


