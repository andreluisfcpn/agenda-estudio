import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Integration tests run against a DEDICATED test database (never dev/prod data).
// The URL is derived from DATABASE_URL by swapping the db name to *_test, or set
// TEST_DATABASE_URL explicitly. Create + migrate it once with:
//   DATABASE_URL="<...>/studio_scheduler_test" npx prisma db push --schema=prisma/schema.prisma --accept-data-loss
const testDbUrl =
    process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL || '').replace(/\/studio_scheduler(\?|$)/, '/studio_scheduler_test$1');

if (!/_test(\?|$)/.test(testDbUrl)) {
    throw new Error(
        '[integration] refusing to run: could not derive a *_test database URL from DATABASE_URL. ' +
        'Set TEST_DATABASE_URL to a dedicated test database.',
    );
}

// Redis: os testes criam travas de horário (`booking:lock:*`, 10 min) e mutexes. Para não tocar no Redis do
// servidor de dev (nem herdar travas de uma rodada anterior), a suíte usa um banco lógico próprio: TEST_REDIS_URL,
// ou o REDIS_URL do .env com o db trocado para 15. Um REDIS_URL que já aponta para um db ≠ 0 é respeitado.
function deriveTestRedisUrl(): string {
    if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;
    const base = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
        const u = new URL(base);
        const db = u.pathname.replace(/^\//, '');
        if (db && db !== '0') return base;
        u.pathname = '/15';
        return u.toString();
    } catch {
        return base;
    }
}
const testRedisUrl = deriveTestRedisUrl();
const redisIsolated = (() => {
    try {
        const db = new URL(testRedisUrl).pathname.replace(/^\//, '');
        return !!db && db !== '0';
    } catch {
        return false;
    }
})();

export default defineConfig({
    test: {
        include: ['test/integration/**/*.test.ts'],
        // One file at a time, single-threaded: the tests share one test DB + Redis and
        // truncate between cases, so they must not run concurrently.
        fileParallelism: false,
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
        setupFiles: ['test/integration/setup.ts'],
        testTimeout: 20000,
        hookTimeout: 30000,
        // Point Prisma (and everything it imports) at the test DB before any module loads.
        env: {
            DATABASE_URL: testDbUrl,
            REDIS_URL: testRedisUrl,
            // Só com um db de Redis dedicado o setup pode limpá-lo por inteiro (nunca o db 0 do dev).
            INTEGRATION_REDIS_ISOLATED: redisIsolated ? '1' : '',
            NODE_ENV: 'test',
        },
    },
});
