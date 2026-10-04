import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

/**
 * Connection handling.
 *
 * A connection string is a credential. Nothing in this module logs it, embeds it in an
 * error message, or returns it to a caller: validation failures name the variable, never
 * its value.
 */

export type Database = NodePgDatabase<typeof schema>;

/**
 * A transaction handle.
 *
 * Exported as an opaque alias on purpose. Applications pass it from `withTransaction`
 * into the typed writes below without ever importing Drizzle themselves, which keeps
 * domain SQL inside this package.
 */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either a pool-backed database or an open transaction. Every read accepts both. */
export type DbExecutor = Database | DbTx;

export class MissingDatabaseUrlError extends Error {
  constructor(variableName: string) {
    // Names the variable, never its value.
    super(`${variableName} is not set`);
    this.name = 'MissingDatabaseUrlError';
  }
}

/**
 * Read a connection string from the environment.
 *
 * Deliberately does not parse or normalize the URL: a malformed value should fail at
 * connect time with the driver's own error rather than be echoed back here.
 */
export function readDatabaseUrl(
  variableName: 'DATABASE_URL' | 'MIGRATION_DATABASE_URL' | 'TEST_ADMIN_DATABASE_URL',
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[variableName];
  if (value === undefined || value.trim().length === 0) {
    throw new MissingDatabaseUrlError(variableName);
  }
  return value;
}

export interface CreateDbOptions {
  readonly connectionString: string;
  /**
   * Budget this against the host's `max_connections`, shared with every other replica.
   * The worker is long-lived and sequential, so it needs very few.
   */
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
}

export interface DbHandle {
  readonly db: Database;
  /** Release every pooled connection. Call on SIGTERM and at the end of a test file. */
  close(): Promise<void>;
}

export function createDb(options: CreateDbOptions): DbHandle {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });

  // Without a listener, an idle-client error takes the process down. Swallowing it
  // here is wrong too, so it is re-raised as an unhandled rejection the host can log.
  pool.on('error', (error) => {
    queueMicrotask(() => {
      throw error;
    });
  });

  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

/**
 * Run `fn` inside one transaction.
 *
 * This is the only place an application obtains a {@link DbTx}. Writes that must commit
 * together — a message and its document placeholders, an analysis and its escalation —
 * go through a single call, so a failure leaves none of them behind.
 *
 * Never hold one of these open across a provider HTTP call.
 */
export async function withTransaction<T>(db: Database, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
