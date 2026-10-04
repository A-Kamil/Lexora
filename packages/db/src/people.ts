import { eq } from 'drizzle-orm';
import { normalizePhone, toIsoDateTime, type Person } from '@lexora/shared';
import type { DbExecutor } from './client.js';
import { people } from './schema.js';

type PersonRow = typeof people.$inferSelect;

export function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    displayName: row.displayName,
    phoneE164: row.phoneE164,
    role: row.role,
    enrolledAt: row.enrolledAt ? toIsoDateTime(row.enrolledAt) : null,
    lastWhatsappInboundAt: row.lastWhatsappInboundAt
      ? toIsoDateTime(row.lastWhatsappInboundAt)
      : null,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

/**
 * Resolve a raw provider-supplied number to a person.
 *
 * This is **routing, not authentication**. A match means "messages from this number
 * belong to this person's threads"; it is not proof that the sender is that person.
 * Anything built on top of it still has to verify identity its own way.
 *
 * Returns `null` both for an unknown number and for one that cannot be normalized,
 * so a caller cannot accidentally distinguish "no such client" from "bad input" and
 * leak that difference back to the sender.
 */
export async function findPersonByPhone(
  executor: DbExecutor,
  rawPhone: string,
): Promise<Person | null> {
  let phoneE164: string;
  try {
    phoneE164 = normalizePhone(rawPhone);
  } catch {
    return null;
  }

  const rows = await executor.select().from(people).where(eq(people.phoneE164, phoneE164)).limit(1);
  const row = rows[0];
  return row ? toPerson(row) : null;
}

export async function findPersonById(
  executor: DbExecutor,
  personId: string,
): Promise<Person | null> {
  const rows = await executor.select().from(people).where(eq(people.id, personId)).limit(1);
  const row = rows[0];
  return row ? toPerson(row) : null;
}

/**
 * Record that this person sent us something on WhatsApp, which opens their own
 * 24-hour service window.
 *
 * Per recipient: a client's message does not open the lawyer's window, so each
 * person's timestamp is tracked separately and never copied across.
 */
export async function touchWhatsappInbound(
  executor: DbExecutor,
  personId: string,
  at: Date,
): Promise<void> {
  await executor
    .update(people)
    .set({ lastWhatsappInboundAt: at, updatedAt: new Date() })
    .where(eq(people.id, personId));
}
