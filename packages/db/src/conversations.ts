import { and, eq } from 'drizzle-orm';
import {
  toIsoDateTime,
  type Conversation,
  type ConversationChannel,
  type ConversationStatus,
} from '@lexora/shared';
import type { DbExecutor, DbTx } from './client.js';
import {
  ConversationNotFoundError,
  MessageNotFoundError,
  OwnershipViolationError,
} from './errors.js';
import { conversations, messages } from './schema.js';

type ConversationRow = typeof conversations.$inferSelect;

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    caseId: row.caseId,
    personId: row.personId,
    channel: row.channel,
    providerSessionKey: row.providerSessionKey,
    status: row.status,
    summary: row.summary,
    summaryThroughMessageId: row.summaryThroughMessageId,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

export async function findConversationById(
  executor: DbExecutor,
  conversationId: string,
): Promise<Conversation | null> {
  const rows = await executor
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const row = rows[0];
  return row ? toConversation(row) : null;
}

/** The person's one open WhatsApp thread on this case, if it exists. */
export async function findOpenWhatsappConversation(
  executor: DbExecutor,
  caseId: string,
  personId: string,
): Promise<Conversation | null> {
  const rows = await executor
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.caseId, caseId),
        eq(conversations.personId, personId),
        eq(conversations.channel, 'whatsapp'),
        eq(conversations.status, 'open'),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? toConversation(row) : null;
}

export interface CreateConversationInput {
  readonly id?: string;
  readonly caseId: string;
  readonly personId: string;
  readonly channel: ConversationChannel;
  readonly providerSessionKey?: string | null;
  readonly status?: ConversationStatus;
}

/**
 * Open a conversation.
 *
 * Two invariants are left to PostgreSQL rather than checked here: that the person is a
 * member of the case (`conversations_case_member_fkey`) and that they do not already
 * have an open WhatsApp thread on it (`conversations_one_open_whatsapp_idx`). Both
 * surface as constraint violations, which is what makes them safe under concurrency —
 * a read-then-write check would not be.
 */
export async function createConversation(
  executor: DbExecutor,
  input: CreateConversationInput,
): Promise<Conversation> {
  const rows = await executor
    .insert(conversations)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      caseId: input.caseId,
      personId: input.personId,
      channel: input.channel,
      providerSessionKey: input.providerSessionKey ?? null,
      status: input.status ?? 'open',
    })
    .returning();
  return toConversation(rows[0]!);
}

/**
 * Store a conversation summary and the message it was computed through.
 *
 * The cutoff pointer carries only a plain foreign key in the schema, because a
 * composite one would put `conversations` and `messages` in a reference cycle. So the
 * ownership invariant — the cutoff message belongs to *this* conversation — is checked
 * here, inside the caller's transaction, which is the design's stated fallback for
 * constraints SQL cannot express.
 *
 * Requires a transaction: the check and the update must not be separated by another
 * writer.
 */
export async function saveConversationSummary(
  tx: DbTx,
  conversationId: string,
  summary: string,
  throughMessageId: string,
): Promise<void> {
  const conversationRows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conversationRows.length === 0) {
    throw new ConversationNotFoundError(conversationId);
  }

  const messageRows = await tx
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, throughMessageId))
    .limit(1);
  const messageRow = messageRows[0];
  if (!messageRow) {
    throw new MessageNotFoundError(throughMessageId);
  }
  if (messageRow.conversationId !== conversationId) {
    throw new OwnershipViolationError({
      relation: 'conversations.summary_through_message_id',
      expected: conversationId,
      actual: messageRow.conversationId,
    });
  }

  await tx
    .update(conversations)
    .set({
      summary,
      summaryThroughMessageId: throughMessageId,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}
