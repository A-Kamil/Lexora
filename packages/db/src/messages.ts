import { and, asc, eq, sql } from 'drizzle-orm';
import {
  MESSAGE_PAGE_DEFAULT_LIMIT,
  MESSAGE_PAGE_MAX_LIMIT,
  decodeMessageCursor,
  encodeMessageCursor,
  toIsoDateTime,
  type Message,
  type MessageDirection,
  type MessageKind,
  type MessagePage,
  type DeliveryStatus,
} from '@lexora/shared';
import type { DbExecutor, DbTx } from './client.js';
import { messages } from './schema.js';

type MessageRow = typeof messages.$inferSelect;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    caseId: row.caseId,
    conversationId: row.conversationId,
    personId: row.personId,
    direction: row.direction,
    kind: row.kind,
    text: row.text,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    idempotencyKey: row.idempotencyKey,
    deliveryStatus: row.deliveryStatus,
    metadata: row.metadata,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

export interface SaveMessageInput {
  readonly id?: string;
  readonly caseId: string;
  readonly conversationId: string;
  /** Null for platform output with no human on the other side. */
  readonly personId?: string | null;
  readonly direction: MessageDirection;
  readonly kind: MessageKind;
  /** Empty is legitimate for a media message with no caption. */
  readonly text?: string;
  readonly provider?: string | null;
  readonly providerMessageId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly deliveryStatus?: DeliveryStatus;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt?: Date;
}

/**
 * Append a message.
 *
 * Takes a transaction because a message rarely commits alone: intake commits it with
 * its document placeholders and its processing job, and an alert commits it with the
 * escalation that explains it.
 *
 * Three invariants are PostgreSQL's, not this function's:
 * `messages_conversation_case_fkey` rejects a conversation from another case,
 * `messages_case_member_fkey` rejects a named party who is not a case member, and
 * `messages_provider_message_id_idx` rejects a replayed provider delivery. Leaving
 * them to constraints is what makes concurrent duplicates safe.
 */
export async function saveMessage(tx: DbTx, input: SaveMessageInput): Promise<Message> {
  const rows = await tx
    .insert(messages)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      caseId: input.caseId,
      conversationId: input.conversationId,
      personId: input.personId ?? null,
      direction: input.direction,
      kind: input.kind,
      text: input.text ?? '',
      provider: input.provider ?? null,
      providerMessageId: input.providerMessageId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      deliveryStatus: input.deliveryStatus ?? 'none',
      metadata: input.metadata ?? {},
    })
    .returning();
  return toMessage(rows[0]!);
}

export async function findMessageById(
  executor: DbExecutor,
  messageId: string,
): Promise<Message | null> {
  const rows = await executor.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const row = rows[0];
  return row ? toMessage(row) : null;
}

/**
 * Look up a message by the provider's own identifier.
 *
 * This is how a redelivered webhook recognizes work already accepted, so it can return
 * the same acknowledgment instead of creating a second message.
 */
export async function findMessageByProviderId(
  executor: DbExecutor,
  provider: string,
  providerMessageId: string,
): Promise<Message | null> {
  const rows = await executor
    .select()
    .from(messages)
    .where(and(eq(messages.provider, provider), eq(messages.providerMessageId, providerMessageId)))
    .limit(1);
  const row = rows[0];
  return row ? toMessage(row) : null;
}

export interface GetCaseMessagesOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

/**
 * One page of a case's messages, oldest first.
 *
 * Keyset pagination on `(created_at, id)`, not offset. Messages are appended while a
 * client is being paged through, and an offset page would skip or repeat rows as the
 * conversation grows. The pair is a total order — `created_at` can tie, `id` cannot —
 * and it matches `messages_case_chronology_idx`, so each page is one index range scan.
 *
 * `limit` is clamped to {@link MESSAGE_PAGE_MAX_LIMIT} rather than rejected, so a
 * caller asking for too much gets a page instead of an error.
 */
export async function getCaseMessages(
  executor: DbExecutor,
  caseId: string,
  options: GetCaseMessagesOptions = {},
): Promise<MessagePage> {
  const limit = Math.min(
    Math.max(options.limit ?? MESSAGE_PAGE_DEFAULT_LIMIT, 1),
    MESSAGE_PAGE_MAX_LIMIT,
  );

  const after = options.cursor ? decodeMessageCursor(options.cursor) : null;

  const condition = after
    ? and(
        eq(messages.caseId, caseId),
        // Row comparison, which PostgreSQL resolves against the composite index.
        sql`(${messages.createdAt}, ${messages.id}) > (${new Date(after.createdAt)}, ${after.id}::uuid)`,
      )
    : eq(messages.caseId, caseId);

  const rows = await executor
    .select()
    .from(messages)
    .where(condition)
    .orderBy(asc(messages.createdAt), asc(messages.id))
    // One extra row answers "is there a next page?" without a second count query.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map(toMessage);
  const last = page[page.length - 1];

  return {
    messages: page,
    nextCursor:
      hasMore && last ? encodeMessageCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/** Update an outbound message's delivery state. The send lifecycle itself is Task 6. */
export async function setMessageDeliveryStatus(
  executor: DbExecutor,
  messageId: string,
  deliveryStatus: DeliveryStatus,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await executor
    .update(messages)
    .set({
      deliveryStatus,
      ...(metadata === undefined ? {} : { metadata }),
      updatedAt: new Date(),
    })
    .where(eq(messages.id, messageId));
}
