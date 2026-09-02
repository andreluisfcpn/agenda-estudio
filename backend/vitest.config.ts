import { defineConfig, configDefaults } from 'vitest/config';

// Default (unit) run: fast, CI-safe pure-function tests only.
// Integration tests live under test/integration and run via `npm run test:integration`
// against a dedicated test database — excluded here so `npm test` stays quick and DB-free.
export default defineConfig({
    test: {
        exclude: [...configDefaults.exclude, 'test/integration/**'],
    },
});
