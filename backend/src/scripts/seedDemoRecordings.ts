/**
 * ─── Demo recordings seed ───────────────────────────────────────────────────
 * Populates a realistic set of recordings for ONE client so the "Minhas Gravações"
 * screen can be evaluated: an ACTIVE contract + several COMPLETED recordings with
 * rich per-network livestream metrics + a few upcoming sessions + one no-show.
 *
 * Idempotent: it first removes THIS client's payments/bookings/contracts, then recreates.
 * It never touches other users or configuration.
 *
 * Target client is configurable via env SEED_EMAIL (defaults below). If the user does
 * not exist, it is created as a CLIENTE with password "cliente123".
 *
 * Usage (against the DB whose DATABASE_URL is in the environment):
 *   node node_modules/tsx/dist/cli.mjs backend/src/scripts/seedDemoRecordings.ts
 * Against Railway production:
 *   railway run --service agenda-app node node_modules/tsx/dist/cli.mjs backend/src/scripts/seedDemoRecordings.ts
 */

import { prisma } from '../lib/prisma.js';
import { BookingStatus, Tier, ContractType, ContractStatus, Role } from '../generated/prisma/client.js';
import { deriveStreamAggregates } from '../lib/streamMetrics.js';
import bcrypt from 'bcryptjs';

const SEED_EMAIL = process.env.SEED_EMAIL || 'alprogramadorjr@gmail.com';

const TIER_PRICE: Record<string, number> = { COMERCIAL: 30000, AUDIENCIA: 40000, SABADO: 50000 };
const endOf = (start: string) => {
    const [h, m] = start.split(':').map(Number);
    return `${String(h + 2).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
// UTC-midnight date N days from today (Booking.date is @db.Date).
const dayOffset = (days: number) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
};

interface RecSpec {
    daysAgo: number;
    start: string;
    tier: keyof typeof TIER_PRICE;
    status: BookingStatus;
    isLivestream?: boolean;
    platforms?: string[];
    links?: Record<string, string>;
    metrics?: Record<string, { views: number; peak: number; likes: number; comments: number; subscribers?: number }>;
    durationMinutes?: number;
    audienceOrigin?: string;
    clientNotes?: string;
    title?: string;
    cover?: string;
}

// Past / finalized recordings (mix of networks, live vs recorded, and a no-show).
const PAST: RecSpec[] = [
    {
        daysAgo: 7, start: '18:00', tier: 'AUDIENCIA', status: BookingStatus.COMPLETED, isLivestream: true,
        platforms: ['YOUTUBE', 'TIKTOK', 'INSTAGRAM'],
        links: {
            YOUTUBE: 'https://youtu.be/dQw4w9WgXcQ',
            TIKTOK: 'https://www.tiktok.com/@estudio/video/7351234567890',
            INSTAGRAM: 'https://www.instagram.com/reel/CxYz123/',
        },
        metrics: {
            YOUTUBE: { views: 15420, peak: 287, likes: 342, comments: 98, subscribers: 12500 },
            TIKTOK: { views: 8900, peak: 156, likes: 1205, comments: 342, subscribers: 8300 },
            INSTAGRAM: { views: 3100, peak: 87, likes: 450, comments: 124, subscribers: 4100 },
        },
        durationMinutes: 118, audienceOrigin: 'SP, RJ, MG', clientNotes: 'Episódio com convidado especial — ótima repercussão.',
        title: 'Entrevista com convidado especial',
    },
    {
        daysAgo: 14, start: '13:00', tier: 'COMERCIAL', status: BookingStatus.COMPLETED, isLivestream: true,
        platforms: ['YOUTUBE', 'INSTAGRAM'],
        links: { YOUTUBE: 'https://youtu.be/abcd1234', INSTAGRAM: 'https://www.instagram.com/reel/Cab456/' },
        metrics: {
            YOUTUBE: { views: 9800, peak: 190, likes: 210, comments: 64, subscribers: 12600 },
            INSTAGRAM: { views: 2400, peak: 54, likes: 320, comments: 71, subscribers: 4150 },
        },
        durationMinutes: 122, audienceOrigin: 'SP Capital',
        title: 'Bastidores do estúdio',
    },
    {
        daysAgo: 21, start: '20:30', tier: 'AUDIENCIA', status: BookingStatus.COMPLETED, isLivestream: true,
        platforms: ['YOUTUBE', 'TIKTOK', 'INSTAGRAM', 'FACEBOOK'],
        links: {
            YOUTUBE: 'https://youtu.be/zxcv7890', TIKTOK: 'https://www.tiktok.com/@estudio/video/7350000000000',
            INSTAGRAM: 'https://www.instagram.com/reel/Cqw789/', FACEBOOK: 'https://fb.watch/abc123/',
        },
        metrics: {
            YOUTUBE: { views: 21300, peak: 410, likes: 512, comments: 188, subscribers: 12800 },
            TIKTOK: { views: 15600, peak: 240, likes: 2100, comments: 540, subscribers: 8500 },
            INSTAGRAM: { views: 5400, peak: 130, likes: 760, comments: 210, subscribers: 4200 },
            FACEBOOK: { views: 3200, peak: 70, likes: 140, comments: 55, subscribers: 2100 },
        },
        durationMinutes: 130, audienceOrigin: 'Brasil', clientNotes: 'Maior audiência até agora!',
        title: 'Especial de aniversário',
    },
    {
        daysAgo: 30, start: '10:00', tier: 'SABADO', status: BookingStatus.COMPLETED, isLivestream: false,
        platforms: [], links: { GRAVACAO: 'https://youtu.be/recorded001' },
        durationMinutes: 95, audienceOrigin: undefined, clientNotes: 'Gravação fechada (sem transmissão ao vivo).', title: 'Gravação de estúdio (fechada)',
    },
    {
        daysAgo: 45, start: '15:30', tier: 'COMERCIAL', status: BookingStatus.COMPLETED, isLivestream: true,
        platforms: ['YOUTUBE', 'TIKTOK'],
        links: { YOUTUBE: 'https://youtu.be/qwer4567', TIKTOK: 'https://www.tiktok.com/@estudio/video/7349999999999' },
        metrics: {
            YOUTUBE: { views: 7200, peak: 140, likes: 180, comments: 50, subscribers: 12300 },
            TIKTOK: { views: 11200, peak: 200, likes: 1500, comments: 410, subscribers: 8000 },
        },
        durationMinutes: 110, audienceOrigin: 'SP, PR', title: 'Debate da semana',
    },
    {
        daysAgo: 10, start: '18:00', tier: 'AUDIENCIA', status: BookingStatus.FALTA,
        clientNotes: '',
    },
];

// Upcoming sessions (no metrics yet) — one pre-filled with distribution to show "Preparativos".
const UPCOMING: { inDays: number; start: string; tier: keyof typeof TIER_PRICE; status: BookingStatus; platforms?: string[]; links?: Record<string, string> }[] = [
    { inDays: 2, start: '18:00', tier: 'AUDIENCIA', status: BookingStatus.CONFIRMED, platforms: ['YOUTUBE', 'TIKTOK'], links: { YOUTUBE: 'https://youtube.com/@estudio/live' } },
    { inDays: 5, start: '13:00', tier: 'COMERCIAL', status: BookingStatus.RESERVED },
    { inDays: 9, start: '20:30', tier: 'AUDIENCIA', status: BookingStatus.CONFIRMED },
];

async function main() {
    console.log(`\n=== Seed demo recordings for ${SEED_EMAIL} ===\n`);

    // 1. User (find or create)
    let user = await prisma.user.findUnique({ where: { email: SEED_EMAIL } });
    if (!user) {
        const passwordHash = await bcrypt.hash('cliente123', 12);
        user = await prisma.user.create({
            data: { email: SEED_EMAIL, passwordHash, name: 'Cliente Demo', phone: '(22) 99999-0000', role: Role.CLIENTE },
        });
        console.log(`  ✅ Created client ${SEED_EMAIL} (password: cliente123)`);
    } else {
        console.log(`  ✅ Using existing client ${SEED_EMAIL}`);
    }

    // 2. Idempotency: clear this user's transactional data
    await prisma.payment.deleteMany({ where: { userId: user.id } });
    await prisma.booking.deleteMany({ where: { userId: user.id } });
    await prisma.contract.deleteMany({ where: { userId: user.id } });
    console.log('  ✅ Cleared previous demo data for this client');

    // 3. Active FLEX contract (episode credits)
    const contract = await prisma.contract.create({
        data: {
            userId: user.id,
            name: 'Podcast Búzios — 6 meses',
            type: ContractType.FLEX,
            tier: Tier.AUDIENCIA,
            durationMonths: 6,
            discountPct: 40,
            startDate: dayOffset(-60),
            endDate: dayOffset(120),
            status: ContractStatus.ACTIVE,
            flexCreditsTotal: 24,
            flexCreditsRemaining: 16,
            flexCycleStart: dayOffset(-7),
        },
    });
    console.log(`  ✅ Contract: ${contract.name} (FLEX, ACTIVE)`);

    // 4. Past / finalized recordings
    let pastCount = 0;
    for (const r of PAST) {
        const streamMetrics = r.metrics ? JSON.stringify(r.metrics) : null;
        const agg = deriveStreamAggregates(streamMetrics);
        await prisma.booking.create({
            data: {
                userId: user.id,
                contractId: contract.id,
                date: dayOffset(-r.daysAgo),
                startTime: r.start,
                endTime: endOf(r.start),
                status: r.status,
                tierApplied: r.tier as Tier,
                price: TIER_PRICE[r.tier],
                isLivestream: r.isLivestream ?? null,
                platforms: r.platforms ? JSON.stringify(r.platforms) : null,
                platformLinks: r.links ? JSON.stringify(r.links) : null,
                streamMetrics,
                durationMinutes: r.durationMinutes ?? null,
                peakViewers: agg.peakViewers,
                chatMessages: agg.chatMessages,
                audienceOrigin: r.audienceOrigin ?? null,
                clientNotes: r.clientNotes || null,
                episodeTitle: r.title ?? null,
                coverImageUrl: r.cover ?? null,
            },
        });
        pastCount++;
    }
    console.log(`  ✅ ${pastCount} past recordings (COMPLETED/FALTA)`);

    // 5. Upcoming sessions
    let upCount = 0;
    for (const u of UPCOMING) {
        await prisma.booking.create({
            data: {
                userId: user.id,
                contractId: contract.id,
                date: dayOffset(u.inDays),
                startTime: u.start,
                endTime: endOf(u.start),
                status: u.status,
                tierApplied: u.tier as Tier,
                price: TIER_PRICE[u.tier],
                platforms: u.platforms ? JSON.stringify(u.platforms) : null,
                platformLinks: u.links ? JSON.stringify(u.links) : null,
            },
        });
        upCount++;
    }
    console.log(`  ✅ ${upCount} upcoming sessions (CONFIRMED/RESERVED)`);

    console.log('\n✅ Demo recordings seeded. Log in as the client to view "Minhas Gravações".\n');
}

main()
    .catch((e) => { console.error('[seedDemoRecordings] FAILED:', e); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });
