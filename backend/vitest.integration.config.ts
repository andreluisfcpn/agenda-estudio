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
            NODE_ENV: 'test',
        },
    },
});
