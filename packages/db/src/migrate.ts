import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readDatabaseUrl } from './client.js';

/**
 * Apply reviewed SQL migrations.
 *
 * Drizzle records applied migrations in its own table, so running this twice is a
 * no-op the second time. That matters: the deployment order is migration job, then
 * application, and a retried job must not try to recreate a type that already exists.
 *
 * `drizzle-kit push` is deliberately never used. It diffs a live database and invents
 * statements nobody reviewed, which is not acceptable against anything deployed.
 */
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

export async function applyMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  // A dedicated migration identity, separate from the one request handlers hold.
  const connectionString = readDatabaseUrl('MIGRATION_DATABASE_URL');
  await applyMigrations(connectionString);
  // Never print the connection string.
  console.log('migrations applied');
}

// Only run when invoked directly, so importing `applyMigrations` has no side effect.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'migration failed');
    process.exitCode = 1;
  });
}
