import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used for `generate` only.
 *
 * Schema changes are reviewed as SQL in `drizzle/` and applied with `pnpm db:migrate`.
 * `push` is deliberately not wired up: it would diff a live database and invent
 * statements no one reviewed, which is not acceptable against anything deployed.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    // Only read by commands that touch a database; `generate` works without it.
    url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
