import { and, asc, desc, eq } from 'drizzle-orm';
import {
  isValidTimeZone,
  toIsoDateTime,
  type ActiveCaseLookup,
  type Case,
  type CaseContext,
  type CaseMember,
  type Deadline,
} from '@lexora/shared';
import type { DbExecutor } from './client.js';
import { CaseNotFoundError, InvalidTimeZoneError } from './errors.js';
import { toAnalysis } from './analyses.js';
import { toDocumentReference } from './documents.js';
import { analyses, caseMembers, cases, deadlines, documents, people } from './schema.js';

type CaseRow = typeof cases.$inferSelect;
type DeadlineRow = typeof deadlines.$inferSelect;

export function toCase(row: CaseRow): Case {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    jurisdiction: row.jurisdiction,
    language: row.language,
    timezone: row.timezone,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

export function toDeadline(row: DeadlineRow): Deadline {
  return {
    id: row.id,
    caseId: row.caseId,
    title: row.title,
    dueAt: toIsoDateTime(row.dueAt),
    timezone: row.timezone,
    sourceDocumentId: row.sourceDocumentId,
    sourceMessageId: row.sourceMessageId,
    verificationStatus: row.verificationStatus,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

export async function findCaseById(executor: DbExecutor, caseId: string): Promise<Case | null> {
  const rows = await executor.select().from(cases).where(eq(cases.id, caseId)).limit(1);
  const row = rows[0];
  return row ? toCase(row) : null;
}

/**
 * Resolve a person to the one open case we should route their message to.
 *
 * Three outcomes, all explicit:
 *
 * - `none` — they have no open case. The caller acknowledges and processes nothing.
 * - `found` — exactly one. Route to it.
 * - `ambiguous` — more than one. **Stop.** There is no tiebreak here, deliberately:
 *   picking the newest case would silently file a client's message against the wrong
 *   matter, and nothing downstream would reveal the mistake.
 *
 * `ambiguous` carries the ids so an operator can resolve it; the caller must not use
 * them to choose one.
 */
export async function getActiveCase(
  executor: DbExecutor,
  personId: string,
): Promise<ActiveCaseLookup> {
  const rows = await executor
    .select({ case: cases })
    .from(caseMembers)
    .innerJoin(cases, eq(cases.id, caseMembers.caseId))
    .where(and(eq(caseMembers.personId, personId), eq(cases.status, 'open')))
    // Stable order so an ambiguity reports the same id list every time.
    .orderBy(asc(cases.createdAt), asc(cases.id));

  if (rows.length === 0) {
    return { kind: 'none' };
  }
  if (rows.length === 1) {
    // Guaranteed present: length is exactly 1.
    return { kind: 'found', case: toCase(rows[0]!.case) };
  }
  return { kind: 'ambiguous', caseIds: rows.map((row) => row.case.id) };
}

/** A case's members, with the display name joined in so callers need no second read. */
export async function getCaseMembers(executor: DbExecutor, caseId: string): Promise<CaseMember[]> {
  const rows = await executor
    .select({
      caseId: caseMembers.caseId,
      personId: caseMembers.personId,
      role: caseMembers.role,
      isPrimary: caseMembers.isPrimary,
      displayName: people.displayName,
      createdAt: caseMembers.createdAt,
    })
    .from(caseMembers)
    .innerJoin(people, eq(people.id, caseMembers.personId))
    .where(eq(caseMembers.caseId, caseId))
    .orderBy(asc(caseMembers.role), asc(people.displayName));

  return rows.map((row) => ({
    caseId: row.caseId,
    personId: row.personId,
    role: row.role,
    isPrimary: row.isPrimary,
    displayName: row.displayName,
    createdAt: toIsoDateTime(row.createdAt),
  }));
}

/**
 * A case's deadlines, due date first.
 *
 * Returns both verification states in one list. `CaseContext` is what splits them;
 * a direct caller gets the `verificationStatus` and is expected to respect it.
 */
export async function getDeadlines(executor: DbExecutor, caseId: string): Promise<Deadline[]> {
  const rows = await executor
    .select()
    .from(deadlines)
    .where(eq(deadlines.caseId, caseId))
    .orderBy(asc(deadlines.dueAt), asc(deadlines.id));
  return rows.map(toDeadline);
}

/**
 * Everything triage may know about a case, with nothing private in it.
 *
 * Absent by construction: provider secrets, private object keys, signed URLs, and
 * document bodies. `readyDocuments` are references — id, type, size, summary — because
 * the analysis step fetches text separately under its own character budget.
 *
 * Deadlines come back in two lists rather than one. A model-extracted date and a
 * lawyer-confirmed court date are different kinds of fact, and a single list invites
 * a caller to forget which is which.
 */
export async function getCaseContext(executor: DbExecutor, caseId: string): Promise<CaseContext> {
  const caseRecord = await findCaseById(executor, caseId);
  if (!caseRecord) {
    throw new CaseNotFoundError(caseId);
  }

  const [members, allDeadlines, documentRows, analysisRows] = await Promise.all([
    getCaseMembers(executor, caseId),
    getDeadlines(executor, caseId),
    executor
      .select()
      .from(documents)
      .where(and(eq(documents.caseId, caseId), eq(documents.status, 'ready')))
      .orderBy(asc(documents.createdAt), asc(documents.id)),
    executor
      .select()
      .from(analyses)
      .where(eq(analyses.caseId, caseId))
      .orderBy(desc(analyses.createdAt), desc(analyses.id))
      .limit(1),
  ]);

  const latestAnalysisRow = analysisRows[0];

  return {
    case: caseRecord,
    members,
    primaryLawyer: members.find((m) => m.role === 'lawyer' && m.isPrimary) ?? null,
    confirmedDeadlines: allDeadlines.filter((d) => d.verificationStatus === 'confirmed'),
    unverifiedDeadlines: allDeadlines.filter((d) => d.verificationStatus === 'unverified'),
    readyDocuments: documentRows.map(toDocumentReference),
    latestAnalysis: latestAnalysisRow ? toAnalysis(latestAnalysisRow) : null,
  };
}

export interface SaveDeadlineInput {
  readonly id?: string;
  readonly caseId: string;
  readonly title: string;
  readonly dueAt: Date;
  readonly timezone: string;
  readonly sourceDocumentId?: string | null;
  readonly sourceMessageId?: string | null;
  /**
   * Omitted means `unverified`, which is the only value a model-derived date may have.
   * `confirmed` is reserved for a date a human checked.
   */
  readonly verificationStatus?: 'unverified' | 'confirmed';
}

export async function saveDeadline(
  executor: DbExecutor,
  input: SaveDeadlineInput,
): Promise<Deadline> {
  if (!isValidTimeZone(input.timezone)) {
    throw new InvalidTimeZoneError(input.timezone);
  }

  // Cross-case ownership of both sources is enforced by composite foreign keys
  // (`deadlines_source_*_case_fkey`), so no read-then-write check is needed here.
  const rows = await executor
    .insert(deadlines)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      caseId: input.caseId,
      title: input.title,
      dueAt: input.dueAt,
      timezone: input.timezone,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      verificationStatus: input.verificationStatus ?? 'unverified',
    })
    .returning();

  // `returning()` on a single-row insert always yields the row.
  return toDeadline(rows[0]!);
}
