// ─── Notification Template Store ────────────────────────
// Merges admin overrides (notification_templates table) over the code catalog.
// Same in-memory cache pattern as lib/businessConfig.ts (60s TTL, invalidated on
// admin writes). A missing row or a null column means "use the catalog default".

import { prisma } from '../../lib/prisma.js';
import {
    NOTIFICATION_EVENT_CATALOG,
    NOTIFICATION_EVENT_BY_KEY,
    NotificationEventDef,
} from '../../config/notificationEventCatalog.js';

export interface EffectiveEvent {
    def: NotificationEventDef;
    enabled: boolean;
    title: string;                 // effective (override or default)
    message: string;
    severity: 'critical' | 'warning' | 'info' | 'dynamic';
    pushEnabled: boolean;
    isCustomized: boolean;         // a DB row exists for this event
    overrides: {                   // raw stored values (null = default), for the admin UI
        enabled: boolean;
        title: string | null;
        message: string | null;
        severity: string | null;
        pushEnabled: boolean | null;
    } | null;
}

let cache: Map<string, EffectiveEvent> | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

function buildEffective(rows: { eventKey: string; enabled: boolean; title: string | null; message: string | null; severity: string | null; pushEnabled: boolean | null }[]): Map<string, EffectiveEvent> {
    const byKey = new Map(rows.map(r => [r.eventKey, r]));
    const result = new Map<string, EffectiveEvent>();
    for (const def of NOTIFICATION_EVENT_CATALOG) {
        const row = byKey.get(def.eventKey);
        result.set(def.eventKey, {
            def,
            enabled: row ? row.enabled : true,
            title: row?.title ?? def.defaultTitle,
            message: row?.message ?? def.defaultMessage,
            severity: (row?.severity as EffectiveEvent['severity']) ?? def.severity,
            pushEnabled: row?.pushEnabled ?? def.pushDefault,
            isCustomized: !!row,
            overrides: row
                ? { enabled: row.enabled, title: row.title, message: row.message, severity: row.severity, pushEnabled: row.pushEnabled }
                : null,
        });
    }
    return result;
}

async function loadAll(): Promise<Map<string, EffectiveEvent>> {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
    try {
        const rows = await prisma.notificationTemplate.findMany();
        cache = buildEffective(rows);
        cacheAt = now;
        return cache;
    } catch {
        // DB unreachable → fall back to pure defaults (never block a notification).
        return buildEffective([]);
    }
}

/** Effective config for a single event (or undefined if the key is unknown). */
export async function getEffectiveEvent(eventKey: string): Promise<EffectiveEvent | undefined> {
    return (await loadAll()).get(eventKey);
}

/** All effective events (computed rules load this once per GET to avoid N queries). */
export async function getAllEffectiveEvents(): Promise<Map<string, EffectiveEvent>> {
    return loadAll();
}

export function invalidateTemplateCache() {
    cache = null;
}

/** Interpolate {var} placeholders; unknown placeholders are left literal. */
export function renderTemplate(text: string, vars?: Record<string, string | number>): string {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** Whether an eventKey exists in the catalog. */
export function isKnownEvent(eventKey: string): boolean {
    return eventKey in NOTIFICATION_EVENT_BY_KEY;
}
