import { Router, Request, Response } from 'express';
import { getConfigString } from '../../lib/businessConfig.js';
import { redis } from '../../lib/redis.js';

// ─── Ambient (hero weather + day/night) ──────────────────────────────────────
// Presentation-only: drives the subtle weather/day-night layer behind the client
// hero. Source: Open-Meteo (keyless, free). Geocode + forecast are cached in Redis
// so we never spam the API (one studio location, shared by all clients). Any failure
// degrades gracefully to { enabled, weather: null } — the client still themes the hero
// and falls back to clock-based day/night.

type Condition = 'clear' | 'clouds' | 'rain' | 'storm' | 'fog' | 'snow';

// WMO weather_code → coarse condition the UI animates.
function mapCondition(code: number): Condition {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2 || code === 3) return 'clouds';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'clouds';
}

const CONDITION_LABEL: Record<Condition, string> = {
    clear: 'Céu limpo', clouds: 'Nublado', rain: 'Chuva', storm: 'Tempestade', fog: 'Névoa', snow: 'Neve',
};

async function fetchJson(url: string, timeoutMs = 5000): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(t);
    }
}

async function cacheGet(key: string): Promise<any | null> {
    try { const v = await redis.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function cacheSet(key: string, val: unknown, ttlSec: number): Promise<void> {
    try { await redis.set(key, JSON.stringify(val), 'EX', ttlSec); } catch { /* cache best-effort */ }
}

async function geocode(city: string): Promise<{ lat: number; lon: number; name: string } | null> {
    const key = `ambient:geo:${city.toLowerCase().trim()}`;
    const cached = await cacheGet(key);
    if (cached) return cached;
    // Open-Meteo geocoding matches a single place token — "Búzios, RJ" returns nothing,
    // but "Búzios" works. Try the full string first, then progressively drop the
    // state/country suffix after each comma.
    const candidates = city.split(',')
        .map((_, i, arr) => arr.slice(0, arr.length - i).join(',').trim())
        .filter((v, i, a) => v && a.indexOf(v) === i);
    for (const q of candidates) {
        const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=pt&format=json`);
        const r = data?.results?.[0];
        if (r && typeof r.latitude === 'number') {
            const result = { lat: r.latitude, lon: r.longitude, name: r.name as string };
            await cacheSet(key, result, 60 * 60 * 24 * 30); // 30 days
            return result;
        }
    }
    return null;
}

export function registerAmbientRoutes(router: Router) {
    // GET /api/ambient/weather (public)
    router.get('/weather', async (_req: Request, res: Response) => {
        try {
            const enabled = (await getConfigString('ambient_enabled')) !== 'false';
            if (!enabled) { res.json({ enabled: false, weather: null }); return; }

            const weatherOn = (await getConfigString('ambient_weather_enabled')) !== 'false';
            if (!weatherOn) { res.json({ enabled: true, weather: null }); return; }

            const city = (await getConfigString('ambient_location')) || 'Búzios, RJ';
            const geo = await geocode(city);
            if (!geo) { res.json({ enabled: true, weather: null }); return; }

            const wKey = `ambient:weather:${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`;
            let weather = await cacheGet(wKey);
            if (!weather) {
                const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code,is_day&timezone=auto`);
                const cur = data?.current;
                if (!cur || typeof cur.weather_code !== 'number') { res.json({ enabled: true, weather: null }); return; }
                const condition = mapCondition(cur.weather_code);
                weather = {
                    isDay: cur.is_day === 1,
                    condition,
                    label: CONDITION_LABEL[condition],
                    tempC: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
                    city: geo.name,
                    updatedAt: new Date().toISOString(),
                };
                await cacheSet(wKey, weather, 60 * 30); // 30 min
            }
            res.json({ enabled: true, weather });
        } catch {
            // Never fail the page over ambiance — theme + clock day/night still work client-side.
            res.json({ enabled: true, weather: null });
        }
    });
}

const ambientRouter = Router();
registerAmbientRoutes(ambientRouter);
export default ambientRouter;
