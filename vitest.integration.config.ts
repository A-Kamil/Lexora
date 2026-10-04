import { defineConfig } from 'vitest/config';

// Integration and e2e tests: require a reachable PostgreSQL, still no external providers.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each file provisions its own disposable database; keep them from racing on the admin link.
    fileParallelism: false,
  },
});
