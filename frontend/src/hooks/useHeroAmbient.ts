import { useEffect, useState } from 'react';
import { ambientApi, AmbientWeather } from '../api/client';

export type TimeOfDay = 'day' | 'night';
export interface HeroAmbientState {
    enabled: boolean;
    timeOfDay: TimeOfDay;
    condition: AmbientWeather['condition'];
}

// Fallback day/night by the studio's wall clock (America/Sao_Paulo) when the weather
// is off/unavailable — so the hero still themes day vs night without any network.
function clockTimeOfDay(): TimeOfDay {
    try {
        const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
        return hour >= 6 && hour < 18 ? 'day' : 'night';
    } catch {
        return 'day';
    }
}

const optimistic = (): HeroAmbientState => ({ enabled: true, timeOfDay: clockTimeOfDay(), condition: 'clear' });

// Module-level cache so all client tabs share a single weather request.
let cached: HeroAmbientState | null = null;
let inflight: Promise<HeroAmbientState> | null = null;

function load(): Promise<HeroAmbientState> {
    if (cached) return Promise.resolve(cached);
    if (!inflight) {
        inflight = ambientApi.getWeather()
            .then(res => {
                const w = res.weather;
                const state: HeroAmbientState = {
                    enabled: res.enabled !== false,
                    timeOfDay: w ? (w.isDay ? 'day' : 'night') : clockTimeOfDay(),
                    condition: w?.condition || 'clear',
                };
                cached = state;
                return state;
            })
            .catch(() => {
                inflight = null; // allow a later retry
                return optimistic();
            });
    }
    return inflight;
}

/**
 * Ambient state for the client hero: whether the effect is enabled (admin),
 * day vs night, and the current weather condition. Renders immediately with a
 * clock-based fallback, then refines with real weather when it arrives.
 */
export function useHeroAmbient(): HeroAmbientState {
    const [state, setState] = useState<HeroAmbientState>(() => cached ?? optimistic());
    useEffect(() => {
        let alive = true;
        load().then(s => { if (alive) setState(s); });
        return () => { alive = false; };
    }, []);
    return state;
}
