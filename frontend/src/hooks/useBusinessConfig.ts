import { useState, useEffect } from 'react';
import { pricingApi } from '../api/client';

// Default values (used while loading or on error)
const DEFAULTS: Record<string, number> = {
    discount_3months: 30,
    discount_6months: 40,
    sessions_per_month: 4,
    episodes_3months: 12,
    episodes_6months: 24,
    pix_extra_discount_pct: 10,
    card_fee_3x_pct: 15,
    card_fee_6x_pct: 20,
    service_discount_3months: 30,
    service_discount_6months: 40,
    cancellation_fine_pct: 20,
    first_booking_min_days: 1,
    first_booking_max_days: 15,
    reschedule_max_days: 7,
    reschedule_min_hours: 24,
    booking_min_advance_minutes: 30,
};

// Module-level cache so the request is only made once across all components
let cachedConfig: Record<string, number> | null = null;
let fetchPromise: Promise<Record<string, number>> | null = null;

async function fetchConfig(): Promise<Record<string, number>> {
    if (cachedConfig) return cachedConfig;
    if (!fetchPromise) {
        fetchPromise = pricingApi.getBusinessConfigPublic()
            .then(res => {
                // Coerce all values to numbers for type safety
                const parsed: Record<string, number> = {};
                for (const [k, v] of Object.entries(res.config)) {
                    parsed[k] = typeof v === 'number' ? v : Number(v) || 0;
                }
                cachedConfig = parsed;
                return parsed;
            })
            .catch(() => { fetchPromise = null; return DEFAULTS; });
    }
    return fetchPromise;
}

export function useBusinessConfig() {
    const [config, setConfig] = useState<Record<string, number>>(cachedConfig || DEFAULTS);
    const [loaded, setLoaded] = useState<boolean>(!!cachedConfig);

    useEffect(() => {
        if (cachedConfig) { setConfig(cachedConfig); setLoaded(true); return; }
        fetchConfig().then(c => { setConfig(c); setLoaded(true); });
    }, []);

    const get = (key: string): number => config[key] ?? DEFAULTS[key] ?? 0;

    return { config, get, loaded };
}

/** Call this after admin saves business config to invalidate the module-level cache */
export function invalidateFrontendConfigCache() {
    cachedConfig = null;
    fetchPromise = null;
}
