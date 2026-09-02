import { beforeAll, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/lib/prisma';
import { redis } from '../../src/lib/redis';

// Safety: refuse to touch anything that isn't the dedicated *_test database.
async function assertTestDb() {
    const [{ current_database }] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
        'SELECT current_database()',
    );
    if (!/_test$/.test(current_database)) {
        throw new Error(
            `[integration] connected to "${current_database}" — refusing to run (expected a *_test database).`,
        );
    }
    return current_database;
}

/** Empty every table (except Prisma's bookkeeping) so each test starts from a clean slate. */
export async function truncateAll() {
    const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    if (rows.length === 0) return;
    const list = rows.map(r => `"public"."${r.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

beforeAll(async () => {
    const db = await assertTestDb();
    // Clear any lock keys a previous crashed run may have left behind.
    const keys = await redis.keys('lock:*');
    if (keys.length) await redis.del(...keys);
    // eslint-disable-next-line no-console
    console.log(`[integration] using test database "${db}"`);
});

beforeEach(async () => {
    await truncateAll();
});

afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
});
