import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, readDatabaseUrl, withTransaction, type DbTx } from './client.js';
import {
  caseMembers,
  cases,
  conversations,
  deadlines,
  documents,
  messages,
  people,
} from './schema.js';

/**
 * Synthetic demo fixtures.
 *
 * Every value here is invented. Sarah Miller and John Smith are fictional names, the
 * case is a fictional criminal proceeding, and the documents are a few lines of made-up
 * text rather than real filings.
 *
 * The phone numbers use ITU country code **+999**, which is reserved and routes to no
 * subscriber anywhere. That is on purpose: a seeded number cannot reach a real person
 * even if some future send path forgets to check its allowlist. Real sandbox numbers for
 * a live run come from `DEMO_CLIENT_PHONE` / `DEMO_LAWYER_PHONE`, never from here.
 *
 * The seed performs no network call, uploads no object, and sends no message.
 *
 * ## Idempotence
 *
 * Every identifier below is fixed, and every insert is `ON CONFLICT DO NOTHING`
 * targeting its **primary key specifically**. Running the seed a second time inserts
 * nothing, updates nothing and deletes nothing, so it is safe against a database
 * someone has since worked in.
 *
 * The conflict target is explicit rather than bare for a reason: an untargeted
 * `DO NOTHING` would also swallow a collision on, say, `phone_e164` held by a
 * *different* person, and the seed would then fail several statements later on a
 * foreign key, half applied. Targeting the key makes idempotence mean "this exact row
 * is already here" and lets anything else fail loudly.
 */

export const SEED_IDS = {
  clientPerson: '0b7d2c1a-1111-4000-8000-000000000001',
  lawyerPerson: '0b7d2c1a-1111-4000-8000-000000000002',
  case: '0b7d2c1a-2222-4000-8000-000000000001',
  clientConversation: '0b7d2c1a-3333-4000-8000-000000000001',
  messageIntake: '0b7d2c1a-4444-4000-8000-000000000001',
  messageAcknowledgement: '0b7d2c1a-4444-4000-8000-000000000002',
  messageWithAttachments: '0b7d2c1a-4444-4000-8000-000000000003',
  documentSummons: '0b7d2c1a-5555-4000-8000-000000000001',
  documentCorrespondence: '0b7d2c1a-5555-4000-8000-000000000002',
  deadlineHearing: '0b7d2c1a-6666-4000-8000-000000000001',
} as const;

/**
 * Reserved-range numbers. See the note above.
 *
 * Exported so a test can push them through `normalizePhone`. A fixture that satisfies
 * the column's regex but is rejected by the application's own normalizer would be
 * unroutable: `findPersonByPhone` would never match it, and the failure would only
 * show up as a seeded case that cannot receive a message.
 */
export const SEED_CLIENT_PHONE = '+999700000001';
export const SEED_LAWYER_PHONE = '+999700000002';

/**
 * A fixed instant, so repeated seeds and test assertions agree.
 *
 * Message timestamps are derived from it rather than from `now()`: chronology
 * assertions need the order to be the same on every run.
 */
const SEED_EPOCH = new Date('2026-10-01T09:00:00.000Z');
const minutesAfterEpoch = (minutes: number): Date =>
  new Date(SEED_EPOCH.getTime() + minutes * 60_000);

/**
 * The fictional hearing instant.
 *
 * Fixed by default so the seed stays deterministic. `SEED_HEARING_AT` overrides it for
 * a live demo that wants a next-day hearing; because inserts never update, the override
 * only takes effect on a database that has not been seeded yet.
 */
function resolveHearingAt(env: NodeJS.ProcessEnv): Date {
  const override = env.SEED_HEARING_AT;
  if (override === undefined || override.trim().length === 0) {
    return new Date('2026-10-08T08:30:00.000Z');
  }
  const parsed = new Date(override);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('SEED_HEARING_AT is not a valid ISO 8601 instant');
  }
  return parsed;
}

export interface SeedResult {
  /** False when the fixtures were already present and nothing was written. */
  readonly inserted: boolean;
  readonly caseId: string;
}

export async function seedDemoFixtures(
  tx: DbTx,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  const existing = await tx
    .select({ id: cases.id })
    .from(cases)
    .where(eq(cases.id, SEED_IDS.case))
    .limit(1);
  if (existing.length > 0) {
    return { inserted: false, caseId: SEED_IDS.case };
  }

  await tx
    .insert(people)
    .values([
      {
        id: SEED_IDS.clientPerson,
        displayName: 'Sarah Miller',
        phoneE164: SEED_CLIENT_PHONE,
        role: 'client',
        enrolledAt: SEED_EPOCH,
        // Set so the seeded case looks like one with a live service window. Still
        // synthetic: no message was ever received from this number.
        lastWhatsappInboundAt: minutesAfterEpoch(30),
      },
      {
        id: SEED_IDS.lawyerPerson,
        displayName: 'John Smith',
        phoneE164: SEED_LAWYER_PHONE,
        role: 'lawyer',
        enrolledAt: SEED_EPOCH,
        lastWhatsappInboundAt: null,
      },
    ])
    .onConflictDoNothing({ target: people.id });

  await tx
    .insert(cases)
    .values({
      id: SEED_IDS.case,
      title: 'FICTIONAL DEMO — criminal proceedings, S. Miller',
      status: 'open',
      // Explicit fixture values. Nothing derives these from a phone number.
      jurisdiction: 'FR',
      language: 'en',
      timezone: 'Europe/Paris',
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
    })
    .onConflictDoNothing({ target: cases.id });

  await tx
    .insert(caseMembers)
    .values([
      {
        caseId: SEED_IDS.case,
        personId: SEED_IDS.clientPerson,
        role: 'client',
        isPrimary: true,
      },
      {
        caseId: SEED_IDS.case,
        personId: SEED_IDS.lawyerPerson,
        role: 'lawyer',
        // The one primary lawyer, which `case_members_one_primary_lawyer_idx` enforces.
        isPrimary: true,
      },
    ])
    .onConflictDoNothing({ target: [caseMembers.caseId, caseMembers.personId] });

  await tx
    .insert(conversations)
    .values({
      id: SEED_IDS.clientConversation,
      caseId: SEED_IDS.case,
      personId: SEED_IDS.clientPerson,
      channel: 'whatsapp',
      status: 'open',
      createdAt: SEED_EPOCH,
      updatedAt: SEED_EPOCH,
    })
    .onConflictDoNothing({ target: conversations.id });

  // The lawyer's own WhatsApp thread is created by the escalation path when it first
  // needs one (Task 6), not seeded here.

  await tx
    .insert(messages)
    .values([
      {
        id: SEED_IDS.messageIntake,
        caseId: SEED_IDS.case,
        conversationId: SEED_IDS.clientConversation,
        personId: SEED_IDS.clientPerson,
        direction: 'inbound',
        kind: 'text',
        text: 'Hello, I received a letter from the court and I do not understand what it asks of me.',
        provider: 'seed',
        providerMessageId: 'SEED-INBOUND-0001',
        metadata: { synthetic: true },
        createdAt: minutesAfterEpoch(30),
      },
      {
        id: SEED_IDS.messageAcknowledgement,
        caseId: SEED_IDS.case,
        conversationId: SEED_IDS.clientConversation,
        // No human author: this is platform output.
        personId: null,
        direction: 'outbound',
        kind: 'system',
        text: 'Thank you. Could you send a photo or a PDF of every page you received?',
        provider: 'seed',
        providerMessageId: 'SEED-OUTBOUND-0001',
        // `simulated`, never `delivered`: nothing was ever sent.
        deliveryStatus: 'simulated',
        metadata: { synthetic: true },
        createdAt: minutesAfterEpoch(31),
      },
      {
        id: SEED_IDS.messageWithAttachments,
        caseId: SEED_IDS.case,
        conversationId: SEED_IDS.clientConversation,
        personId: SEED_IDS.clientPerson,
        direction: 'inbound',
        // A media message's own text may be empty; here it carries a caption.
        kind: 'media',
        text: 'Here are the two pages.',
        provider: 'seed',
        providerMessageId: 'SEED-INBOUND-0002',
        metadata: { synthetic: true, mediaCount: 2 },
        createdAt: minutesAfterEpoch(45),
      },
    ])
    .onConflictDoNothing({ target: messages.id });

  await tx
    .insert(documents)
    .values([
      {
        id: SEED_IDS.documentSummons,
        caseId: SEED_IDS.case,
        messageId: SEED_IDS.messageWithAttachments,
        mediaIndex: 0,
        storageKey: `${SEED_IDS.case}/${SEED_IDS.documentSummons}/original`,
        mimeType: 'application/pdf',
        byteSize: 18_432,
        // A fixture digest. No object exists under the storage key above.
        sha256: 'a'.repeat(64),
        status: 'ready',
        extractedText: [
          'FICTIONAL DOCUMENT — not a real court record.',
          '',
          'TRIBUNAL JUDICIAIRE DE PARIS',
          'Summons to appear, case 2026/FIXTURE/0001.',
          'S. Miller is summoned to appear before the court on 8 October 2026 at 10:30.',
          'Failure to appear may be considered by the court.',
        ].join('\n'),
        metadata: {
          synthetic: true,
          documentType: 'court_summons',
          summary: 'Fictional summons to appear, naming a hearing on 8 October 2026 at 10:30.',
          dateMentions: [
            // Extracted by a model, therefore unverified. The seeded deadline that
            // corresponds to this mention is marked `confirmed` only because the
            // fixture represents a lawyer having already checked it.
            { text: '8 October 2026 at 10:30', isoDate: '2026-10-08', sourcePage: 1 },
          ],
        },
        createdAt: minutesAfterEpoch(46),
        updatedAt: minutesAfterEpoch(48),
      },
      {
        id: SEED_IDS.documentCorrespondence,
        caseId: SEED_IDS.case,
        messageId: SEED_IDS.messageWithAttachments,
        mediaIndex: 1,
        storageKey: `${SEED_IDS.case}/${SEED_IDS.documentCorrespondence}/original`,
        mimeType: 'image/jpeg',
        byteSize: 204_800,
        sha256: 'b'.repeat(64),
        status: 'ready',
        extractedText: [
          'FICTIONAL DOCUMENT — not a real court record.',
          '',
          'Photograph of a one-page letter acknowledging receipt of the summons,',
          'dated 29 September 2026, with no legible signature.',
        ].join('\n'),
        metadata: {
          synthetic: true,
          documentType: 'correspondence',
          summary: 'Fictional acknowledgement letter, dated 29 September 2026.',
          dateMentions: [{ text: '29 September 2026', isoDate: '2026-09-29', sourcePage: 1 }],
        },
        createdAt: minutesAfterEpoch(46),
        updatedAt: minutesAfterEpoch(49),
      },
    ])
    .onConflictDoNothing({ target: documents.id });

  await tx
    .insert(deadlines)
    .values({
      id: SEED_IDS.deadlineHearing,
      caseId: SEED_IDS.case,
      title: 'FICTIONAL hearing — case 2026/FIXTURE/0001',
      dueAt: resolveHearingAt(env),
      // Stated in the court's zone, which happens to match the case's here.
      timezone: 'Europe/Paris',
      sourceDocumentId: SEED_IDS.documentSummons,
      sourceMessageId: SEED_IDS.messageWithAttachments,
      // `confirmed` represents a lawyer having checked the date. Nothing automated
      // produces this value; a model-extracted date stays `unverified`.
      verificationStatus: 'confirmed',
      createdAt: minutesAfterEpoch(50),
      updatedAt: minutesAfterEpoch(50),
    })
    .onConflictDoNothing({ target: deadlines.id });

  // No analysis and no escalation are seeded. Those are produced by the pipeline, and
  // inventing them here would make a later run look as though it had already worked.
  return { inserted: true, caseId: SEED_IDS.case };
}

async function main(): Promise<void> {
  const handle = createDb({ connectionString: readDatabaseUrl('DATABASE_URL'), maxConnections: 1 });
  try {
    const result = await withTransaction(handle.db, (tx) => seedDemoFixtures(tx));
    console.log(
      result.inserted
        ? `seeded synthetic demo fixtures (case ${result.caseId})`
        : `synthetic demo fixtures already present (case ${result.caseId}), nothing written`,
    );
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'seed failed');
    process.exitCode = 1;
  });
}
