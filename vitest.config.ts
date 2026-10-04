import { defineConfig } from 'vitest/config';

// Unit tests only: colocated `*.test.ts` inside packages, no database, no credentials.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
