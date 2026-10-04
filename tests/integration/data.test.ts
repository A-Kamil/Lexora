import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  createConversation,
  createDb,
  findAnalysisByTriggerKey,
  findDocumentById,
  findMessageById,
  findMessageByProviderId,
  findPersonByPhone,
  getActiveCase,
  getCaseContext,
  getCaseDocuments,
  getCaseMessages,
  getDeadlines,
  getReadyCaseDocuments,
  saveAnalysis,
  saveConversationSummary,
  saveDeadline,
  saveDocumentPlaceholder,
  saveEscalation,
  saveMessage,
  schema,
  setMessageDeliveryStatus,
  updateDocumentState,
  updateEscalation,
  withTransaction,
  OwnershipViolationError,
  type Database,
  type DbHandle,
} from '@lexora/db';
import {
  ESCALATION_STATUSES,
  IsoDateTimeSchema,
  UuidSchema,
  type CaseAnalysis,
} from '@lexora/shared';
import { eq, sql } from 'drizzle-orm';

/**
 * Data-service integration tests.
 *
 * Every test runs against a real PostgreSQL, because the invariants under test are
 * PostgreSQL's: composite foreign keys, partial unique indexes and check constraints.
 * Asserting them against a mock would prove nothing.
 *
 * The suite provisions its own database and drops it afterwards, so it never touches
 * the development data. No external provider is contacted and no credential is needed
 * beyond a local connection.
 */

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ??
  (() => {
    const base = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!base) {
      throw new Error(
        'set TEST_ADMIN_DATABASE_URL (or DATABASE_URL) to a local PostgreSQL that may create databases',
      );
    }
    const url = new URL(base);
    url.pathname = '/postgres';
    return url.toString();
  })();

const TEST_DB_NAME = `lexora_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

function urlForDatabase(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

const testDatabaseUrl = urlForDatabase(ADMIN_URL, TEST_DB_NAME);

let handle: DbHandle;
let db: Database;

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    // Identifier is generated locally from a UUID, so no injection surface.
    await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } finally {
    await admin.end();
  }
  await applyMigrations(testDatabaseUrl);
  handle = createDb({ connectionString: testDatabaseUrl, maxConnections: 5 });
  db = handle.db;
});

afterAll(async () => {
  await handle?.close();
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers. Every value is synthetic; phones use the reserved +999 range.
// ---------------------------------------------------------------------------

let phoneCounter = 0;
/**
 * Still inside the reserved +999 range, but on a distinct `+99971…` prefix so a test
 * fixture can never collide with the seed's own `+99970…` numbers.
 */
const nextPhone = (): string => `+99971${String(++phoneCounter).padStart(7, '0')}`;

interface CaseFixture {
  caseId: string;
  clientId: string;
  lawyerId: string;
  conversationId: string;
}

async function createPerson(role: 'client' | 'lawyer', phone = nextPhone()): Promise<string> {
  const rows = await db
    .insert(schema.people)
    .values({ displayName: `Fixture ${role} ${phone}`, phoneE164: phone, role })
    .returning({ id: schema.people.id });
  return rows[0]!.id;
}

async function createCase(
  options: { status?: 'open' | 'closed'; clientId?: string; lawyerId?: string } = {},
): Promise<CaseFixture> {
  const caseRows = await db
    .insert(schema.cases)
    .values({
      title: 'FICTIONAL test case',
      status: options.status ?? 'open',
      jurisdiction: 'FR',
      language: 'en',
      timezone: 'Europe/Paris',
    })
    .returning({ id: schema.cases.id });
  const caseId = caseRows[0]!.id;

  const clientId = options.clientId ?? (await createPerson('client'));
  const lawyerId = options.lawyerId ?? (await createPerson('lawyer'));

  await db.insert(schema.caseMembers).values([
    { caseId, personId: clientId, role: 'client', isPrimary: true },
    { caseId, personId: lawyerId, role: 'lawyer', isPrimary: true },
  ]);

  const conversation = await createConversation(db, {
    caseId,
    personId: clientId,
    channel: 'whatsapp',
  });

  return { caseId, clientId, lawyerId, conversationId: conversation.id };
}

const analysisResult: CaseAnalysis = {
  issue: 'Fictional test issue.',
  urgency: 'HIGH',
  urgencyReason: 'A fictional hearing falls within the week.',
  requiresLawyer: true,
  missingInformation: [],
  requestedDocuments: [],
  recommendedActions: ['Lawyer to review'],
};

/** The conservative result a provider failure stores instead of fabricating a finding. */
const fallbackResult: CaseAnalysis = {
  issue: 'Automated assessment of this message failed.',
  urgency: 'HIGH',
  urgencyReason: 'Automated assessment failed, so urgency is unknown and treated as high.',
  requiresLawyer: true,
  missingInformation: [],
  requestedDocuments: [],
  recommendedActions: ['Lawyer to review this case manually'],
};

interface Rejection {
  readonly error: Error;
  /**
   * The PostgreSQL constraint that rejected the write, or null when the write was
   * stopped in application code before reaching the database.
   */
  readonly constraint: string | null;
  /** SQLSTATE: 23505 unique, 23503 foreign key, 23514 check. */
  readonly code: string | null;
  /** The most specific name available: a domain error's own, else the driver's. */
  readonly name: string;
}

/**
 * Run a write that must be rejected, and report *why* it was.
 *
 * Drizzle wraps a driver failure in a plain `Error` whose message is only the failed
 * query, so asserting on the message would pass for any rejection at all. The actual
 * constraint name lives on the wrapped `cause`, and naming it is the whole point: a
 * test that merely proves "something failed" does not prove the right rule fired.
 */
async function expectRejected(fn: () => Promise<unknown>): Promise<Rejection> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the write to be rejected').toBeInstanceOf(Error);
  const error = caught as Error & { cause?: unknown };
  const cause = error.cause as (Error & { constraint?: string; code?: string }) | undefined;
  return {
    error,
    constraint: cause?.constraint ?? null,
    code: cause?.code ?? null,
    name: error.name !== 'Error' ? error.name : (cause?.name ?? 'Error'),
  };
}

// ---------------------------------------------------------------------------

describe('migrations', () => {
  it('builds the nine domain tables from an empty database', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      'analyses',
      'case_members',
      'cases',
      'conversations',
      'deadlines',
      'documents',
      'escalations',
      'messages',
      'people',
    ]);
  });

  it('creates no queue table: durable jobs are a later task', async () => {
    const result = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_name LIKE 'pgboss%' OR table_schema = 'pgboss'`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('does not create api_requests, which arrives with the voice API', async () => {
    const result = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'api_requests'`,
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('applies a second time without destroying data', async () => {
    const fixture = await createCase();
    await applyMigrations(testDatabaseUrl);
    const stillThere = await db
      .select()
      .from(schema.cases)
      .where(eq(schema.cases.id, fixture.caseId));
    expect(stillThere).toHaveLength(1);
    const tables = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables.rows[0]?.count).toBe('9');
  });
});

describe('phone routing', () => {
  it('finds a person by a channel-prefixed number', async () => {
    const phone = nextPhone();
    const personId = await createPerson('client', phone);
    const found = await findPersonByPhone(db, `whatsapp:${phone}`);
    expect(found?.id).toBe(personId);
    expect(UuidSchema.safeParse(found?.id).success).toBe(true);
    expect(IsoDateTimeSchema.safeParse(found?.createdAt).success).toBe(true);
  });

  it('returns null for an unknown number and for one it refuses to normalize', async () => {
    expect(await findPersonByPhone(db, '+999999999999')).toBeNull();
    // A national number is not interpreted against an assumed region, so it matches nothing.
    expect(await findPersonByPhone(db, '0612345678')).toBeNull();
  });

  it('rejects a non-E.164 number at the column, not only in application code', async () => {
    const rejection = await expectRejected(() =>
      db
        .insert(schema.people)
        .values({ displayName: 'Bypass', phoneE164: '0612345678', role: 'client' }),
    );
    expect(rejection.constraint).toBe('people_phone_e164_is_e164');
  });

  it('refuses two people on one number', async () => {
    const phone = nextPhone();
    await createPerson('client', phone);
    const rejection = await expectRejected(() =>
      db.insert(schema.people).values({ displayName: 'Twin', phoneE164: phone, role: 'client' }),
    );
    expect(rejection.constraint).toBe('people_phone_e164_key');
  });
});

describe('getActiveCase', () => {
  it('returns none when the person has no open case', async () => {
    const personId = await createPerson('client');
    expect(await getActiveCase(db, personId)).toEqual({ kind: 'none' });
  });

  it('returns found with exactly one open case', async () => {
    const fixture = await createCase();
    const result = await getActiveCase(db, fixture.clientId);
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.case.id).toBe(fixture.caseId);
      expect(result.case.jurisdiction).toBe('FR');
      expect(result.case.timezone).toBe('Europe/Paris');
    }
  });

  it('returns ambiguous for two open cases, and never picks one', async () => {
    const clientId = await createPerson('client');
    const first = await createCase({ clientId });
    const second = await createCase({ clientId });

    const result = await getActiveCase(db, clientId);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.caseIds).toHaveLength(2);
      expect(new Set(result.caseIds)).toEqual(new Set([first.caseId, second.caseId]));
    }
  });

  it('ignores closed cases', async () => {
    const clientId = await createPerson('client');
    await createCase({ clientId, status: 'closed' });
    expect(await getActiveCase(db, clientId)).toEqual({ kind: 'none' });

    const open = await createCase({ clientId });
    const result = await getActiveCase(db, clientId);
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.case.id).toBe(open.caseId);
    }
  });
});

describe('case membership', () => {
  it('allows only one primary lawyer per case', async () => {
    const fixture = await createCase();
    const secondLawyer = await createPerson('lawyer');
    const rejection = await expectRejected(() =>
      db.insert(schema.caseMembers).values({
        caseId: fixture.caseId,
        personId: secondLawyer,
        role: 'lawyer',
        isPrimary: true,
      }),
    );
    expect(rejection.constraint).toBe('case_members_one_primary_lawyer_idx');
  });

  it('allows additional non-primary lawyers', async () => {
    const fixture = await createCase();
    const secondLawyer = await createPerson('lawyer');
    await db.insert(schema.caseMembers).values({
      caseId: fixture.caseId,
      personId: secondLawyer,
      role: 'lawyer',
      isPrimary: false,
    });
    const members = await getCaseContext(db, fixture.caseId);
    expect(members.members.filter((m) => m.role === 'lawyer')).toHaveLength(2);
    expect(members.primaryLawyer?.personId).toBe(fixture.lawyerId);
  });

  it('refuses the same person twice on one case', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      db
        .insert(schema.caseMembers)
        .values({ caseId: fixture.caseId, personId: fixture.clientId, role: 'client' }),
    );
    expect(rejection.constraint).toBe('case_members_pkey');
  });
});

describe('cross-case ownership', () => {
  it('refuses a message bound to another case’s conversation', async () => {
    const own = await createCase();
    const other = await createCase();
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: own.caseId,
          // Belongs to `other`, not `own`.
          conversationId: other.conversationId,
          personId: own.clientId,
          direction: 'inbound',
          kind: 'text',
          text: 'should not be stored',
        }),
      ),
    );
    expect(rejection.constraint).toBe('messages_conversation_case_fkey');
  });

  it('refuses a message whose named party is not a member of the case', async () => {
    const own = await createCase();
    const stranger = await createPerson('client');
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: own.caseId,
          conversationId: own.conversationId,
          personId: stranger,
          direction: 'inbound',
          kind: 'text',
          text: 'should not be stored',
        }),
      ),
    );
    expect(rejection.constraint).toBe('messages_case_member_fkey');
  });

  it('refuses a conversation for someone who is not a case member', async () => {
    const own = await createCase();
    const stranger = await createPerson('client');
    const rejection = await expectRejected(() =>
      createConversation(db, { caseId: own.caseId, personId: stranger, channel: 'voice' }),
    );
    expect(rejection.constraint).toBe('conversations_case_member_fkey');
  });

  it('refuses a document whose case differs from its message’s', async () => {
    const own = await createCase();
    const other = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: own.caseId,
        conversationId: own.conversationId,
        personId: own.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveDocumentPlaceholder(tx, {
          id: randomUUID(),
          caseId: other.caseId,
          messageId: message.id,
          mediaIndex: 0,
          mimeType: 'application/pdf',
        }),
      ),
    );
    expect(rejection.constraint).toBe('documents_message_case_fkey');
  });

  it('refuses a deadline whose source belongs to another case', async () => {
    const own = await createCase();
    const other = await createCase();
    const foreignMessage = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: other.caseId,
        conversationId: other.conversationId,
        personId: other.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'other case',
      }),
    );
    const rejection = await expectRejected(() =>
      saveDeadline(db, {
        caseId: own.caseId,
        title: 'FICTIONAL hearing',
        dueAt: new Date('2026-11-01T09:00:00Z'),
        timezone: 'Europe/Paris',
        sourceMessageId: foreignMessage.id,
      }),
    );
    expect(rejection.constraint).toBe('deadlines_source_message_case_fkey');
  });

  it('refuses an analysis on another case’s conversation', async () => {
    const own = await createCase();
    const other = await createCase();
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveAnalysis(tx, {
          caseId: own.caseId,
          conversationId: other.conversationId,
          triggerKey: `ownership:${randomUUID()}`,
          result: analysisResult,
          status: 'ok',
          model: 'fixture',
          promptVersion: 'v1',
        }),
      ),
    );
    expect(rejection.constraint).toBe('analyses_conversation_case_fkey');
  });

  it('refuses an escalation on another case’s analysis', async () => {
    const own = await createCase();
    const other = await createCase();
    const foreignAnalysis = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: other.caseId,
        conversationId: other.conversationId,
        triggerKey: `ownership-escalation:${randomUUID()}`,
        result: analysisResult,
        status: 'ok',
        model: 'fixture',
        promptVersion: 'v1',
      }),
    );
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveEscalation(tx, {
          caseId: own.caseId,
          analysisId: foreignAnalysis.analysis.id,
          lawyerId: own.lawyerId,
          reason: 'should not be stored',
        }),
      ),
    );
    expect(rejection.constraint).toBe('escalations_analysis_case_fkey');
  });

  it('refuses an escalation naming a lawyer who is not a member of the case', async () => {
    const own = await createCase();
    const stranger = await createPerson('lawyer');
    const analysis = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: own.caseId,
        conversationId: own.conversationId,
        triggerKey: `stranger-lawyer:${randomUUID()}`,
        result: analysisResult,
        status: 'ok',
        model: 'fixture',
        promptVersion: 'v1',
      }),
    );
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveEscalation(tx, {
          caseId: own.caseId,
          analysisId: analysis.analysis.id,
          lawyerId: stranger,
          reason: 'should not be stored',
        }),
      ),
    );
    expect(rejection.constraint).toBe('escalations_lawyer_case_member_fkey');
  });

  it('refuses a conversation summary pointing at another conversation’s message', async () => {
    const own = await createCase();
    const other = await createCase();
    const foreignMessage = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: other.caseId,
        conversationId: other.conversationId,
        personId: other.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'other conversation',
      }),
    );

    // This invariant is a transactional check rather than a composite foreign key,
    // because such a key would put conversations and messages in a reference cycle.
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveConversationSummary(tx, own.conversationId, 'summary', foreignMessage.id),
      ),
    );
    expect(rejection.error).toBeInstanceOf(OwnershipViolationError);

    const unchanged = await db
      .select({ summary: schema.conversations.summary })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, own.conversationId));
    expect(unchanged[0]?.summary).toBeNull();
  });

  it('accepts a summary pointing at its own conversation’s message', async () => {
    const own = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: own.caseId,
        conversationId: own.conversationId,
        personId: own.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'last turn',
      }),
    );
    await withTransaction(db, (tx) =>
      saveConversationSummary(tx, own.conversationId, 'Fictional summary.', message.id),
    );
    const rows = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, own.conversationId));
    expect(rows[0]?.summary).toBe('Fictional summary.');
    expect(rows[0]?.summaryThroughMessageId).toBe(message.id);
  });
});

describe('conversations', () => {
  it('allows only one open WhatsApp thread per person per case', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      createConversation(db, {
        caseId: fixture.caseId,
        personId: fixture.clientId,
        channel: 'whatsapp',
      }),
    );
    expect(rejection.constraint).toBe('conversations_one_open_whatsapp_idx');
  });

  it('allows a new WhatsApp thread once the previous one is complete', async () => {
    const fixture = await createCase();
    await db
      .update(schema.conversations)
      .set({ status: 'complete' })
      .where(eq(schema.conversations.id, fixture.conversationId));
    const next = await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.clientId,
      channel: 'whatsapp',
    });
    expect(next.id).not.toBe(fixture.conversationId);
  });

  it('allows several voice conversations, since each call is its own session', async () => {
    const fixture = await createCase();
    const first = await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.clientId,
      channel: 'voice',
      providerSessionKey: `voice-${randomUUID()}`,
    });
    const second = await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.clientId,
      channel: 'voice',
      providerSessionKey: `voice-${randomUUID()}`,
    });
    expect(first.id).not.toBe(second.id);
  });

  it('refuses a duplicate provider session key', async () => {
    const fixture = await createCase();
    const key = `voice-${randomUUID()}`;
    await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.clientId,
      channel: 'voice',
      providerSessionKey: key,
    });
    const rejection = await expectRejected(() =>
      createConversation(db, {
        caseId: fixture.caseId,
        personId: fixture.clientId,
        channel: 'voice',
        providerSessionKey: key,
      }),
    );
    expect(rejection.constraint).toBe('conversations_provider_session_key_key');
  });
});

describe('messages', () => {
  it('refuses a replayed provider delivery', async () => {
    const fixture = await createCase();
    const providerMessageId = `SM${randomUUID().replaceAll('-', '')}`;
    const first = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'first delivery',
        provider: 'twilio',
        providerMessageId,
      }),
    );

    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          personId: fixture.clientId,
          direction: 'inbound',
          kind: 'text',
          text: 'replayed delivery',
          provider: 'twilio',
          providerMessageId,
        }),
      ),
    );
    expect(rejection.constraint).toBe('messages_provider_message_id_idx');

    // The replay finds the message already accepted, which is how a webhook returns
    // the same acknowledgment without doing the work twice.
    const found = await findMessageByProviderId(db, 'twilio', providerMessageId);
    expect(found?.id).toBe(first.id);
    expect(found?.text).toBe('first delivery');
  });

  it('allows many messages without a provider id', async () => {
    const fixture = await createCase();
    for (let i = 0; i < 3; i += 1) {
      await withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          direction: 'outbound',
          kind: 'system',
          text: `system note ${i}`,
          deliveryStatus: 'simulated',
        }),
      );
    }
    const page = await getCaseMessages(db, fixture.caseId);
    expect(page.messages).toHaveLength(3);
  });

  it('scopes an idempotency key to its conversation', async () => {
    const fixture = await createCase();
    const other = await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.clientId,
      channel: 'voice',
      providerSessionKey: `voice-${randomUUID()}`,
    });

    await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'turn 1',
        idempotencyKey: 'turn-1',
      }),
    );

    // Same key, different conversation: accepted, because the voice API's external
    // message id is only unique within its own session.
    await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: other.id,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'turn 1 of another session',
        idempotencyKey: 'turn-1',
      }),
    );

    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          personId: fixture.clientId,
          direction: 'inbound',
          kind: 'text',
          text: 'duplicate turn',
          idempotencyKey: 'turn-1',
        }),
      ),
    );
    expect(rejection.constraint).toBe('messages_conversation_idempotency_key_idx');
  });

  it('refuses a delivery status on an inbound message', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          personId: fixture.clientId,
          direction: 'inbound',
          kind: 'text',
          text: 'inbound',
          deliveryStatus: 'delivered',
        }),
      ),
    );
    expect(rejection.constraint).toBe('messages_inbound_has_no_delivery');
  });

  it('stores a system message with no author', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: null,
        direction: 'outbound',
        kind: 'system',
        text: 'Deterministic alert copy.',
        deliveryStatus: 'pending',
      }),
    );
    expect(message.personId).toBeNull();
    expect(message.deliveryStatus).toBe('pending');
  });

  it('stores a media message with empty text', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    expect(message.text).toBe('');
  });

  it('pages in a stable order, even when timestamps tie', async () => {
    const fixture = await createCase();
    const sameInstant = new Date('2026-10-02T12:00:00.000Z');
    for (let i = 0; i < 7; i += 1) {
      await withTransaction(db, (tx) =>
        saveMessage(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          personId: fixture.clientId,
          direction: 'inbound',
          kind: 'text',
          text: `message ${i}`,
          // Every row shares an instant, so only the id breaks the tie.
          createdAt: sameInstant,
        }),
      );
    }

    const first = await getCaseMessages(db, fixture.caseId, { limit: 3 });
    expect(first.messages).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await getCaseMessages(db, fixture.caseId, {
      limit: 3,
      cursor: first.nextCursor,
    });
    const third = await getCaseMessages(db, fixture.caseId, {
      limit: 3,
      cursor: second.nextCursor,
    });

    expect(third.nextCursor).toBeNull();
    const ids = [...first.messages, ...second.messages, ...third.messages].map((m) => m.id);
    expect(ids).toHaveLength(7);
    // No row is skipped and none is served twice.
    expect(new Set(ids).size).toBe(7);
    expect([...ids].sort()).toEqual([...ids].sort());
  });

  it('clamps an oversized page request to the documented maximum', async () => {
    const fixture = await createCase();
    const page = await getCaseMessages(db, fixture.caseId, { limit: 5_000 });
    expect(page.messages.length).toBeLessThanOrEqual(100);
  });

  it('serializes instants as ISO 8601', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'iso check',
      }),
    );
    expect(IsoDateTimeSchema.safeParse(message.createdAt).success).toBe(true);
    expect(message.createdAt).toMatch(/Z$/);
  });
});

describe('documents', () => {
  async function mediaMessage(fixture: CaseFixture) {
    return withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
  }

  it('exists as a pending placeholder before any byte is fetched, and without analysis', async () => {
    const fixture = await createCase();
    const message = await mediaMessage(fixture);
    const documentId = randomUUID();
    const placeholder = await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'application/pdf',
      }),
    );

    expect(placeholder.status).toBe('pending');
    expect(placeholder.byteSize).toBeNull();
    expect(placeholder.sha256).toBeNull();
    expect(placeholder.extractedText).toBeNull();
    // The key is deterministic, so a retried upload addresses the same object.
    expect(placeholder.storageKey).toBe(`${fixture.caseId}/${documentId}/original`);

    // No analysis exists for this case, and the document is readable regardless.
    const context = await getCaseContext(db, fixture.caseId);
    expect(context.latestAnalysis).toBeNull();
    expect(await getCaseDocuments(db, fixture.caseId)).toHaveLength(1);
  });

  it('refuses two placeholders for one attachment slot', async () => {
    const fixture = await createCase();
    const message = await mediaMessage(fixture);
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: randomUUID(),
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'application/pdf',
      }),
    );
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveDocumentPlaceholder(tx, {
          id: randomUUID(),
          caseId: fixture.caseId,
          messageId: message.id,
          mediaIndex: 0,
          mimeType: 'application/pdf',
        }),
      ),
    );
    expect(rejection.constraint).toBe('documents_message_id_media_index_key');
  });

  it('walks pending → stored → extracting → ready and is then retrievable', async () => {
    const fixture = await createCase();
    const message = await mediaMessage(fixture);
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'application/pdf',
      }),
    );

    await updateDocumentState(db, documentId, {
      status: 'stored',
      byteSize: 1024,
      sha256: 'c'.repeat(64),
    });
    await updateDocumentState(db, documentId, { status: 'extracting' });
    await updateDocumentState(db, documentId, {
      status: 'ready',
      extractedText: 'FICTIONAL extracted text.',
      metadata: { documentType: 'court_summons', summary: 'Fictional summons.' },
    });

    const ready = await getReadyCaseDocuments(db, fixture.caseId);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.extractedText).toContain('FICTIONAL');

    const reference = (await getCaseContext(db, fixture.caseId)).readyDocuments[0];
    expect(reference?.documentType).toBe('court_summons');
    expect(reference?.extractedTextLength).toBe('FICTIONAL extracted text.'.length);
    // A reference carries no private object key and no body.
    expect(Object.keys(reference ?? {})).not.toContain('storageKey');
    expect(Object.keys(reference ?? {})).not.toContain('extractedText');
  });

  it('refuses to claim stored without a size and digest', async () => {
    const fixture = await createCase();
    const message = await mediaMessage(fixture);
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'image/png',
      }),
    );
    const rejection = await expectRejected(() =>
      updateDocumentState(db, documentId, { status: 'stored' }),
    );
    expect(rejection.constraint).toBe('documents_stored_has_bytes');
  });

  it('refuses to claim ready without extracted text', async () => {
    const fixture = await createCase();
    const message = await mediaMessage(fixture);
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'image/jpeg',
      }),
    );
    const rejection = await expectRejected(() =>
      updateDocumentState(db, documentId, {
        status: 'ready',
        byteSize: 10,
        sha256: 'd'.repeat(64),
      }),
    );
    expect(rejection.constraint).toBe('documents_ready_has_text');
  });

  it('keeps a reason on a terminal failure and refuses one without it', async () => {
    const fixture = await createCase();
    const message = await mediaMessage(fixture);
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'application/pdf',
      }),
    );

    const rejection = await expectRejected(() =>
      updateDocumentState(db, documentId, { status: 'rejected' }),
    );
    expect(rejection.constraint).toBe('documents_terminal_has_reason');

    await updateDocumentState(db, documentId, {
      status: 'rejected',
      errorCode: 'unsupported_media_type',
    });
    const stored = await findDocumentById(db, documentId);
    expect(stored?.status).toBe('rejected');
    expect(stored?.errorCode).toBe('unsupported_media_type');
    // A rejected document is not a ready one, so no analysis may claim to have read it.
    expect(await getReadyCaseDocuments(db, fixture.caseId)).toHaveLength(0);
  });
});

describe('analyses', () => {
  it('stores an ok result', async () => {
    const fixture = await createCase();
    const saved = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey: `message:${randomUUID()}:v1`,
        result: analysisResult,
        status: 'ok',
        model: 'fixture-model',
        promptVersion: 'v1',
        contextMessageIds: [],
        contextDocumentIds: [],
      }),
    );
    expect(saved.existing).toBe(false);
    expect(saved.analysis.status).toBe('ok');
    expect(saved.analysis.schemaVersion).toBe(1);
    expect(saved.analysis.result).toEqual(analysisResult);
  });

  it('stores a fallback result conservatively rather than leaving no row', async () => {
    const fixture = await createCase();
    const saved = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey: `message:${randomUUID()}:v1`,
        result: fallbackResult,
        status: 'fallback',
        model: 'fixture-model',
        promptVersion: 'v1',
      }),
    );
    expect(saved.analysis.status).toBe('fallback');
    expect(saved.analysis.result.urgency).toBe('HIGH');
    expect(saved.analysis.result.requiresLawyer).toBe(true);
    expect(saved.analysis.result.urgencyReason).toContain('failed');
  });

  it('is idempotent by trigger key: a restarted job reuses the stored result', async () => {
    const fixture = await createCase();
    const triggerKey = `message:${randomUUID()}:v1`;

    const first = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey,
        result: analysisResult,
        status: 'ok',
        model: 'fixture-model',
        promptVersion: 'v1',
      }),
    );

    const second = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey,
        // A different assessment of the same event must not replace the first.
        result: { ...analysisResult, urgency: 'LOW', issue: 'A second opinion.' },
        status: 'ok',
        model: 'fixture-model',
        promptVersion: 'v1',
      }),
    );

    expect(second.existing).toBe(true);
    expect(second.analysis.id).toBe(first.analysis.id);
    expect(second.analysis.result.urgency).toBe('HIGH');

    const rows = await db
      .select()
      .from(schema.analyses)
      .where(eq(schema.analyses.triggerKey, triggerKey));
    expect(rows).toHaveLength(1);
    expect(await findAnalysisByTriggerKey(db, triggerKey)).not.toBeNull();
  });

  it('refuses a result that is not a valid CaseAnalysis', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveAnalysis(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          triggerKey: `invalid:${randomUUID()}`,
          // Extra key, which the strict schema rejects before anything is written.
          result: { ...analysisResult, confidence: 0.9 } as unknown as CaseAnalysis,
          status: 'ok',
          model: 'fixture-model',
          promptVersion: 'v1',
        }),
      ),
    );
    expect(rejection.name).toMatch(/ZodError/);
  });

  it('records provenance, including which messages and documents were shown', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'context message',
      }),
    );
    const saved = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey: `provenance:${randomUUID()}`,
        result: analysisResult,
        status: 'ok',
        model: 'fixture-model',
        promptVersion: 'prompt-v3',
        contextMessageIds: [message.id],
        contextDocumentIds: [],
      }),
    );
    expect(saved.analysis.contextMessageIds).toEqual([message.id]);
    // No document was shown, and the record says so rather than implying otherwise.
    expect(saved.analysis.contextDocumentIds).toEqual([]);
    expect(saved.analysis.model).toBe('fixture-model');
    expect(saved.analysis.promptVersion).toBe('prompt-v3');
  });
});

describe('deadlines', () => {
  it('defaults to unverified and never promotes itself', async () => {
    const fixture = await createCase();
    const deadline = await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL date mentioned in a document',
      dueAt: new Date('2026-11-12T09:00:00Z'),
      timezone: 'Europe/Paris',
    });
    expect(deadline.verificationStatus).toBe('unverified');

    // Re-read after other writes: nothing in the data layer changes it.
    await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL confirmed hearing',
      dueAt: new Date('2026-11-20T09:00:00Z'),
      timezone: 'Europe/Paris',
      verificationStatus: 'confirmed',
    });
    const all = await getDeadlines(db, fixture.caseId);
    expect(all.find((d) => d.id === deadline.id)?.verificationStatus).toBe('unverified');
  });

  it('keeps the two verification states distinct in CaseContext', async () => {
    const fixture = await createCase();
    await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL unverified mention',
      dueAt: new Date('2026-11-01T09:00:00Z'),
      timezone: 'Europe/Paris',
    });
    await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL confirmed hearing',
      dueAt: new Date('2026-11-02T09:00:00Z'),
      timezone: 'Europe/Paris',
      verificationStatus: 'confirmed',
    });

    const context = await getCaseContext(db, fixture.caseId);
    expect(context.unverifiedDeadlines.map((d) => d.title)).toEqual([
      'FICTIONAL unverified mention',
    ]);
    expect(context.confirmedDeadlines.map((d) => d.title)).toEqual(['FICTIONAL confirmed hearing']);
    expect(await getDeadlines(db, fixture.caseId)).toHaveLength(2);
  });

  it('orders by due date and keeps the stated zone', async () => {
    const fixture = await createCase();
    await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL later',
      dueAt: new Date('2026-12-01T09:00:00Z'),
      timezone: 'Europe/Paris',
    });
    await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL earlier',
      // Stated in a different zone from the case's, which the row preserves.
      dueAt: new Date('2026-11-01T09:00:00Z'),
      timezone: 'America/Martinique',
    });
    const deadlines = await getDeadlines(db, fixture.caseId);
    expect(deadlines.map((d) => d.title)).toEqual(['FICTIONAL earlier', 'FICTIONAL later']);
    expect(deadlines[0]?.timezone).toBe('America/Martinique');
    expect(IsoDateTimeSchema.safeParse(deadlines[0]?.dueAt).success).toBe(true);
  });

  it('refuses an invented time zone', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      saveDeadline(db, {
        caseId: fixture.caseId,
        title: 'FICTIONAL bad zone',
        dueAt: new Date('2026-11-01T09:00:00Z'),
        timezone: 'Europe/Atlantis',
      }),
    );
    expect(rejection.name).toBe('InvalidTimeZoneError');
  });
});

describe('escalations', () => {
  async function analysisFor(fixture: CaseFixture) {
    const saved = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey: `escalation:${randomUUID()}`,
        result: analysisResult,
        status: 'ok',
        model: 'fixture-model',
        promptVersion: 'v1',
      }),
    );
    return saved.analysis;
  }

  it('creates at most one escalation per analysis', async () => {
    const fixture = await createCase();
    const analysis = await analysisFor(fixture);

    const first = await withTransaction(db, (tx) =>
      saveEscalation(tx, {
        caseId: fixture.caseId,
        analysisId: analysis.id,
        lawyerId: fixture.lawyerId,
        reason: 'urgency HIGH',
      }),
    );
    expect(first.existing).toBe(false);
    expect(first.escalation.status).toBe('pending');

    // A retried job must not queue a second alert to the lawyer.
    const second = await withTransaction(db, (tx) =>
      saveEscalation(tx, {
        caseId: fixture.caseId,
        analysisId: analysis.id,
        lawyerId: fixture.lawyerId,
        reason: 'urgency HIGH',
      }),
    );
    expect(second.existing).toBe(true);
    expect(second.escalation.id).toBe(first.escalation.id);

    const rows = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.analysisId, analysis.id));
    expect(rows).toHaveLength(1);
  });

  it('records blocked_no_lawyer when the case has no assigned lawyer', async () => {
    const fixture = await createCase();
    const analysis = await analysisFor(fixture);
    const saved = await withTransaction(db, (tx) =>
      saveEscalation(tx, {
        caseId: fixture.caseId,
        analysisId: analysis.id,
        lawyerId: null,
        status: 'blocked_no_lawyer',
        reason: 'no lawyer assigned to this case',
      }),
    );
    expect(saved.escalation.status).toBe('blocked_no_lawyer');
    expect(saved.escalation.lawyerId).toBeNull();
  });

  it('refuses blocked_no_lawyer while a lawyer is named', async () => {
    const fixture = await createCase();
    const analysis = await analysisFor(fixture);
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveEscalation(tx, {
          caseId: fixture.caseId,
          analysisId: analysis.id,
          lawyerId: fixture.lawyerId,
          status: 'blocked_no_lawyer',
          reason: 'contradictory',
        }),
      ),
    );
    expect(rejection.constraint).toBe('escalations_blocked_no_lawyer_has_no_lawyer');
  });

  it('persists every documented state, keeping accepted distinct from delivered', async () => {
    const fixture = await createCase();
    const observed: string[] = [];

    for (const status of ESCALATION_STATUSES) {
      const analysis = await analysisFor(fixture);
      const saved = await withTransaction(db, (tx) =>
        saveEscalation(tx, {
          caseId: fixture.caseId,
          analysisId: analysis.id,
          // `blocked_no_lawyer` is the one state that requires no lawyer.
          lawyerId: status === 'blocked_no_lawyer' ? null : fixture.lawyerId,
          status,
          reason: `fixture ${status}`,
        }),
      );
      observed.push(saved.escalation.status);
    }

    expect(observed).toEqual([...ESCALATION_STATUSES]);
    expect(observed).toContain('accepted');
    expect(observed).toContain('delivered');
    expect(observed).toContain('delivery_unknown');
    expect(observed).toContain('simulated');
  });

  it('correlates an accepted send without calling it delivered', async () => {
    const fixture = await createCase();
    const analysis = await analysisFor(fixture);
    const outbound = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.lawyerId,
        direction: 'outbound',
        kind: 'system',
        text: 'Deterministic alert copy.',
        deliveryStatus: 'sending',
      }),
    );
    const saved = await withTransaction(db, (tx) =>
      saveEscalation(tx, {
        caseId: fixture.caseId,
        analysisId: analysis.id,
        lawyerId: fixture.lawyerId,
        outboundMessageId: outbound.id,
        status: 'sending',
        reason: 'urgency HIGH',
      }),
    );

    await updateEscalation(db, saved.escalation.id, {
      status: 'accepted',
      providerMessageId: 'SM-fixture-accepted',
    });

    const rows = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, saved.escalation.id));
    // The provider took the request. That is not evidence the lawyer received it.
    expect(rows[0]?.status).toBe('accepted');
    expect(rows[0]?.status).not.toBe('delivered');
    expect(rows[0]?.providerMessageId).toBe('SM-fixture-accepted');
    expect(rows[0]?.outboundMessageId).toBe(outbound.id);
  });
});

describe('CaseContext', () => {
  it('exposes the case, members and latest analysis, and no private object key', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'application/pdf',
      }),
    );
    await updateDocumentState(db, documentId, {
      status: 'ready',
      byteSize: 2048,
      sha256: 'e'.repeat(64),
      extractedText: 'FICTIONAL text.',
    });
    await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey: `context:${randomUUID()}`,
        result: analysisResult,
        status: 'ok',
        model: 'fixture-model',
        promptVersion: 'v1',
      }),
    );

    const context = await getCaseContext(db, fixture.caseId);
    expect(context.case.id).toBe(fixture.caseId);
    expect(context.members).toHaveLength(2);
    expect(context.primaryLawyer?.personId).toBe(fixture.lawyerId);
    expect(context.latestAnalysis?.result.urgency).toBe('HIGH');

    // Nothing private travels in a context object.
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('original');
    expect(serialized).not.toContain('e'.repeat(64));
    expect(serialized).not.toContain('FICTIONAL text.');
  });

  it('returns the newest analysis when several exist', async () => {
    const fixture = await createCase();
    for (const urgency of ['LOW', 'CRITICAL'] as const) {
      await withTransaction(db, (tx) =>
        saveAnalysis(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          triggerKey: `latest:${randomUUID()}`,
          result: { ...analysisResult, urgency },
          status: 'ok',
          model: 'fixture-model',
          promptVersion: 'v1',
        }),
      );
    }
    const context = await getCaseContext(db, fixture.caseId);
    expect(context.latestAnalysis?.result.urgency).toBe('CRITICAL');
  });

  it('fails loudly for an unknown case rather than returning an empty context', async () => {
    const rejection = await expectRejected(() => getCaseContext(db, randomUUID()));
    expect(rejection.name).toBe('CaseNotFoundError');
  });
});

describe('deletes do not cascade through case history', () => {
  it('refuses to delete a person who is party to a case', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      db.delete(schema.people).where(eq(schema.people.id, fixture.clientId)),
    );
    expect(rejection.constraint).toBe('case_members_person_id_fkey');

    // The membership, and therefore the record of who the case concerned, survives.
    const members = await getCaseContext(db, fixture.caseId);
    expect(members.members.map((m) => m.personId)).toContain(fixture.clientId);
  });

  it('refuses to delete a case that has messages', async () => {
    const fixture = await createCase();
    await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'history',
      }),
    );
    const rejection = await expectRejected(() =>
      db.delete(schema.cases).where(eq(schema.cases.id, fixture.caseId)),
    );
    expect(rejection.constraint).toMatch(/fkey$/);
  });

  it('refuses to delete a message that an analysis-era deadline cites', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'the letter says 12 November',
      }),
    );
    await saveDeadline(db, {
      caseId: fixture.caseId,
      title: 'FICTIONAL cited date',
      dueAt: new Date('2026-11-12T09:00:00Z'),
      timezone: 'Europe/Paris',
      sourceMessageId: message.id,
    });
    const rejection = await expectRejected(() =>
      db.delete(schema.messages).where(eq(schema.messages.id, message.id)),
    );
    expect(rejection.constraint).toBe('deadlines_source_message_case_fkey');
  });
});

describe('blank strings in uniqueness columns', () => {
  /**
   * `''` is not a missing value to PostgreSQL: it satisfies NOT NULL and it occupies the
   * unique slot. Every column below takes part in an idempotency decision, so a blank
   * value there does not merely look untidy — it makes unrelated records collide.
   */
  it('refuses a blank analysis trigger key, which would hand one analysis another’s result', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveAnalysis(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          triggerKey: '   ',
          result: analysisResult,
          status: 'ok',
          model: 'fixture-model',
          promptVersion: 'v1',
        }),
      ),
    );
    expect(rejection.constraint).toBe('analyses_trigger_key_not_blank');
  });

  it('refuses blank provenance on an analysis', async () => {
    const fixture = await createCase();
    for (const [field, constraint] of [
      ['model', 'analyses_model_not_blank'],
      ['promptVersion', 'analyses_prompt_version_not_blank'],
    ] as const) {
      const rejection = await expectRejected(() =>
        withTransaction(db, (tx) =>
          saveAnalysis(tx, {
            caseId: fixture.caseId,
            conversationId: fixture.conversationId,
            triggerKey: `blank-${field}:${randomUUID()}`,
            result: analysisResult,
            status: 'ok',
            model: field === 'model' ? '' : 'fixture-model',
            promptVersion: field === 'promptVersion' ? '' : 'v1',
          }),
        ),
      );
      expect(rejection.constraint).toBe(constraint);
    }
  });

  it('refuses a blank provider identifier or idempotency key on a message', async () => {
    const fixture = await createCase();
    const cases: [Partial<Parameters<typeof saveMessage>[1]>, string][] = [
      [{ provider: '', providerMessageId: 'SM1' }, 'messages_provider_not_blank'],
      [{ provider: 'twilio', providerMessageId: '' }, 'messages_provider_message_id_not_blank'],
      [{ idempotencyKey: '' }, 'messages_idempotency_key_not_blank'],
    ];
    for (const [overrides, constraint] of cases) {
      const rejection = await expectRejected(() =>
        withTransaction(db, (tx) =>
          saveMessage(tx, {
            caseId: fixture.caseId,
            conversationId: fixture.conversationId,
            personId: fixture.clientId,
            direction: 'inbound',
            kind: 'text',
            text: 'blank key probe',
            ...overrides,
          }),
        ),
      );
      expect(rejection.constraint).toBe(constraint);
    }
  });

  it('refuses a blank voice session key, which two sessions would collide on', async () => {
    const fixture = await createCase();
    const rejection = await expectRejected(() =>
      createConversation(db, {
        caseId: fixture.caseId,
        personId: fixture.clientId,
        channel: 'voice',
        providerSessionKey: '',
      }),
    );
    expect(rejection.constraint).toBe('conversations_provider_session_key_not_blank');
  });

  it('refuses a blank storage key or MIME type on a document', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    const blankKey = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveDocumentPlaceholder(tx, {
          id: randomUUID(),
          caseId: fixture.caseId,
          messageId: message.id,
          mediaIndex: 0,
          mimeType: 'application/pdf',
          storageKey: '',
        }),
      ),
    );
    expect(blankKey.constraint).toBe('documents_storage_key_not_blank');

    const blankMime = await expectRejected(() =>
      withTransaction(db, (tx) =>
        saveDocumentPlaceholder(tx, {
          id: randomUUID(),
          caseId: fixture.caseId,
          messageId: message.id,
          mediaIndex: 1,
          mimeType: '',
        }),
      ),
    );
    expect(blankMime.constraint).toBe('documents_mime_type_not_blank');
  });
});

describe('future state transitions (Tasks 3, 6, 7 and 8)', () => {
  /**
   * Each test walks a lifecycle the later tasks describe, to prove no check constraint
   * here blocks a transition those tasks will need. This is how the over-strict
   * `conversations_summary_requires_cutoff` was caught, and it is cheaper to keep the
   * walks than to rediscover the next one mid-task.
   */

  it('walks a conversation open → completing → complete, with the cutoff fixed first', async () => {
    const fixture = await createCase();
    const last = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'text',
        text: 'final turn',
      }),
    );

    // Task 8 marks `completing` with the cutoff *before* any summary exists.
    await db
      .update(schema.conversations)
      .set({ status: 'completing', summaryThroughMessageId: last.id })
      .where(eq(schema.conversations.id, fixture.conversationId));
    let rows = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, fixture.conversationId));
    expect(rows[0]?.status).toBe('completing');
    expect(rows[0]?.summary).toBeNull();
    expect(rows[0]?.summaryThroughMessageId).toBe(last.id);

    // Then the summary is written against that same cutoff, and the state closes.
    await withTransaction(db, (tx) =>
      saveConversationSummary(tx, fixture.conversationId, 'Fictional summary.', last.id),
    );
    await db
      .update(schema.conversations)
      .set({ status: 'complete' })
      .where(eq(schema.conversations.id, fixture.conversationId));
    rows = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, fixture.conversationId));
    expect(rows[0]?.status).toBe('complete');
    expect(rows[0]?.summary).toBe('Fictional summary.');
    expect(rows[0]?.summaryThroughMessageId).toBe(last.id);
  });

  it('accepts a successful extraction that produced zero characters', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'image/png',
      }),
    );
    await updateDocumentState(db, documentId, {
      status: 'stored',
      byteSize: 512,
      sha256: 'f'.repeat(64),
    });
    // A photograph with no legible text: OCR worked, and found nothing. The column
    // distinguishes that from "not extracted" — '' is a result, NULL is an absence.
    await updateDocumentState(db, documentId, { status: 'ready', extractedText: '' });

    const stored = await findDocumentById(db, documentId);
    expect(stored?.status).toBe('ready');
    expect(stored?.extractedText).toBe('');
    expect(stored?.extractedText).not.toBeNull();

    const reference = (await getCaseContext(db, fixture.caseId)).readyDocuments[0];
    expect(reference?.extractedTextLength).toBe(0);
  });

  it('rejects a declared media type before any byte is fetched', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'video/mp4',
      }),
    );
    // Task 7 rejects unsupported media visibly, without downloading it. So `rejected`
    // must be reachable with no size and no digest.
    await updateDocumentState(db, documentId, {
      status: 'rejected',
      errorCode: 'unsupported_media_type',
    });
    const stored = await findDocumentById(db, documentId);
    expect(stored?.status).toBe('rejected');
    expect(stored?.byteSize).toBeNull();
    expect(stored?.sha256).toBeNull();
    expect(stored?.errorCode).toBe('unsupported_media_type');
  });

  it('fails a document after storage without losing its bytes or its reason', async () => {
    const fixture = await createCase();
    const message = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.clientId,
        direction: 'inbound',
        kind: 'media',
      }),
    );
    const documentId = randomUUID();
    await withTransaction(db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id: documentId,
        caseId: fixture.caseId,
        messageId: message.id,
        mediaIndex: 0,
        mimeType: 'application/pdf',
      }),
    );
    await updateDocumentState(db, documentId, {
      status: 'stored',
      byteSize: 4096,
      sha256: '1'.repeat(64),
    });
    await updateDocumentState(db, documentId, { status: 'extracting' });
    await updateDocumentState(db, documentId, { status: 'failed', errorCode: 'ocr_timeout' });

    const stored = await findDocumentById(db, documentId);
    expect(stored?.status).toBe('failed');
    expect(stored?.errorCode).toBe('ocr_timeout');
    // The stored object is still addressable, so a retry needs no re-download.
    expect(stored?.byteSize).toBe(4096);
    expect(stored?.sha256).toBe('1'.repeat(64));
    // And it is not ready, so nothing may claim this document was reviewed.
    expect(await getReadyCaseDocuments(db, fixture.caseId)).toHaveLength(0);
  });

  it('walks an outbound message and its escalation pending → sending → accepted → delivered', async () => {
    const fixture = await createCase();
    const analysis = (
      await withTransaction(db, (tx) =>
        saveAnalysis(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          triggerKey: `lifecycle:${randomUUID()}`,
          result: analysisResult,
          status: 'ok',
          model: 'fixture-model',
          promptVersion: 'v1',
        }),
      )
    ).analysis;

    // The lawyer gets their own WhatsApp thread on the case; the client's is untouched.
    const lawyerThread = await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.lawyerId,
      channel: 'whatsapp',
    });

    const outbound = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: lawyerThread.id,
        personId: fixture.lawyerId,
        direction: 'outbound',
        kind: 'system',
        text: 'Deterministic alert copy.',
        deliveryStatus: 'pending',
      }),
    );
    const escalation = (
      await withTransaction(db, (tx) =>
        saveEscalation(tx, {
          caseId: fixture.caseId,
          analysisId: analysis.id,
          lawyerId: fixture.lawyerId,
          outboundMessageId: outbound.id,
          reason: 'urgency HIGH',
        }),
      )
    ).escalation;

    for (const status of ['sending', 'accepted', 'delivered'] as const) {
      await setMessageDeliveryStatus(db, outbound.id, status);
      await updateEscalation(db, escalation.id, { status });
    }

    const message = await findMessageById(db, outbound.id);
    const rows = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id));
    expect(message?.deliveryStatus).toBe('delivered');
    expect(rows[0]?.status).toBe('delivered');
  });

  it('parks an ambiguous send in delivery_unknown and records the attempt history', async () => {
    const fixture = await createCase();
    const analysis = (
      await withTransaction(db, (tx) =>
        saveAnalysis(tx, {
          caseId: fixture.caseId,
          conversationId: fixture.conversationId,
          triggerKey: `unknown:${randomUUID()}`,
          result: analysisResult,
          status: 'ok',
          model: 'fixture-model',
          promptVersion: 'v1',
        }),
      )
    ).analysis;
    const outbound = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        personId: fixture.lawyerId,
        direction: 'outbound',
        kind: 'system',
        text: 'Deterministic alert copy.',
        deliveryStatus: 'sending',
        metadata: { attempts: [{ at: '2026-10-02T12:00:00.000Z', outcome: 'timeout' }] },
      }),
    );
    const escalation = (
      await withTransaction(db, (tx) =>
        saveEscalation(tx, {
          caseId: fixture.caseId,
          analysisId: analysis.id,
          lawyerId: fixture.lawyerId,
          outboundMessageId: outbound.id,
          status: 'sending',
          reason: 'urgency HIGH',
        }),
      )
    ).escalation;

    // Acceptance is uncertain, so the record says so and stops rather than resending.
    await setMessageDeliveryStatus(db, outbound.id, 'delivery_unknown', {
      attempts: [
        { at: '2026-10-02T12:00:00.000Z', outcome: 'timeout' },
        { at: '2026-10-02T12:00:30.000Z', outcome: 'inspection_required' },
      ],
    });
    await updateEscalation(db, escalation.id, {
      status: 'delivery_unknown',
      errorCode: 'send_timeout',
    });

    const message = await findMessageById(db, outbound.id);
    expect(message?.deliveryStatus).toBe('delivery_unknown');
    // A second attempt is appended, never written over the first.
    expect((message?.metadata.attempts as unknown[]).length).toBe(2);
    const rows = await db
      .select()
      .from(schema.escalations)
      .where(eq(schema.escalations.id, escalation.id));
    expect(rows[0]?.status).toBe('delivery_unknown');
    expect(rows[0]?.errorCode).toBe('send_timeout');
  });

  it('stores a voice assistant turn, which is outbound with no delivery lifecycle', async () => {
    const fixture = await createCase();
    const session = await createConversation(db, {
      caseId: fixture.caseId,
      personId: fixture.clientId,
      channel: 'voice',
      providerSessionKey: `voice-${randomUUID()}`,
    });
    // Task 8 appends `role: 'client' | 'assistant'` turns. An assistant turn is
    // outbound but was never sent over a messaging provider, so it rests at `none`.
    const turn = await withTransaction(db, (tx) =>
      saveMessage(tx, {
        caseId: fixture.caseId,
        conversationId: session.id,
        personId: fixture.clientId,
        direction: 'outbound',
        kind: 'text',
        text: 'Could you tell me the date on the letter?',
        idempotencyKey: `turn-${randomUUID()}`,
      }),
    );
    expect(turn.deliveryStatus).toBe('none');
  });

  it('stores a fallback naming the model that was attempted but never answered', async () => {
    const fixture = await createCase();
    const saved = await withTransaction(db, (tx) =>
      saveAnalysis(tx, {
        caseId: fixture.caseId,
        conversationId: fixture.conversationId,
        triggerKey: `timeout:${randomUUID()}`,
        result: fallbackResult,
        status: 'fallback',
        // No response came back; provenance still records what the failure is
        // attributable to, which is why `model` is never blank.
        model: 'mistral-fixture-model',
        promptVersion: 'v1',
        contextMessageIds: [],
        contextDocumentIds: [],
      }),
    );
    expect(saved.analysis.status).toBe('fallback');
    expect(saved.analysis.model).toBe('mistral-fixture-model');
    expect(saved.analysis.result.requiresLawyer).toBe(true);

    // A fallback escalates like any other triggering analysis.
    const escalation = await withTransaction(db, (tx) =>
      saveEscalation(tx, {
        caseId: fixture.caseId,
        analysisId: saved.analysis.id,
        lawyerId: fixture.lawyerId,
        reason: 'automated assessment failed',
      }),
    );
    expect(escalation.escalation.status).toBe('pending');
  });
});
