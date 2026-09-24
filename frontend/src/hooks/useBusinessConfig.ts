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
    service_discount_3months: 30,
    service_discount_6months: 40,
    cancellation_fine_pct: 20,
    first_booking_min_days: 1,
    first_booking_max_days: 15,
    reschedule_max_days: 7,
    reschedule_min_hours: 24,
    booking_min_advance_hours: 12,
    // D4/D5: prazo (dias após a gravação perdida, fim do dia em SP) para remarcar a falta
    // justificada / "Não Realizado" do avulso. Chave criada pelo backend (businessConfigCatalog).
    avulso_makeup_days: 7,
};

// Module-level cache so the request is only made once across all components
let cachedConfig: Record<string, number> | null = null;
let cachedRawConfig: Record<string, unknown> | null = null;
let fetchPromise: Promise<Record<string, number>> | null = null;

async function fetchConfig(): Promise<Record<string, number>> {
    if (cachedConfig) return cachedConfig;
    if (!fetchPromise) {
        fetchPromise = pricingApi.getBusinessConfigPublic()
            .then(res => {
                cachedRawConfig = res.config as Record<string, unknown>;
                const parsed: Record<string, number> = {};
                for (const [k, v] of Object.entries(res.config)) {
                    if (typeof v === 'number') parsed[k] = v;
                    else if (typeof v === 'string') parsed[k] = Number(v) || 0;
                    // Objects (JSON configs) are kept in rawConfig only
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
    const getJson = <T = unknown>(key: string): T | null => {
        const raw = cachedRawConfig?.[key];
        return (raw && typeof raw === 'object') ? raw as T : null;
    };
    // Boolean toggles are stored as 'true'/'false' strings (not in the numeric `config` map).
    // Absent key → defaultVal (the public config only returns DB rows; unsaved → default).
    const getBool = (key: string, defaultVal = true): boolean => {
        const raw = cachedRawConfig?.[key];
        if (raw === undefined || raw === null) return defaultVal;
        return raw === true || raw === 'true';
    };
    // Valores textuais (ex.: CSV 'time_slots' = '10:00,13:00') — o mapa numérico acima os zera.
    // Absent key → defaultVal. Para a grade de CONTRATO prefira contractsApi.slotOptions(tier).
    const getString = (key: string, defaultVal = ''): string => {
        const raw = cachedRawConfig?.[key];
        if (raw === undefined || raw === null || typeof raw === 'object') return defaultVal;
        return String(raw);
    };

    return { config, get, getJson, getBool, getString, loaded };
}

/** Call this after admin saves business config to invalidate the module-level cache */
export function invalidateFrontendConfigCache() {
    cachedConfig = null;
    fetchPromise = null;
}
