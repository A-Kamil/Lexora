import { desc, eq } from 'drizzle-orm';
import {
  CASE_ANALYSIS_SCHEMA_VERSION,
  CaseAnalysisSchema,
  toIsoDateTime,
  type Analysis,
  type AnalysisStatus,
  type CaseAnalysis,
} from '@lexora/shared';
import type { DbExecutor, DbTx } from './client.js';
import { analyses } from './schema.js';

type AnalysisRow = typeof analyses.$inferSelect;

export function toAnalysis(row: AnalysisRow): Analysis {
  return {
    id: row.id,
    caseId: row.caseId,
    conversationId: row.conversationId,
    triggerKey: row.triggerKey,
    result: row.result,
    status: row.status,
    model: row.model,
    promptVersion: row.promptVersion,
    schemaVersion: row.schemaVersion,
    contextMessageIds: row.contextMessageIds,
    contextDocumentIds: row.contextDocumentIds,
    createdAt: toIsoDateTime(row.createdAt),
  };
}

export interface SaveAnalysisInput {
  readonly id?: string;
  readonly caseId: string;
  readonly conversationId: string;
  /** Identifies the input event and revision, e.g. `message:{id}:v1`. */
  readonly triggerKey: string;
  readonly result: CaseAnalysis;
  /** `fallback` records that automated assessment failed, conservatively. */
  readonly status: AnalysisStatus;
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion?: number;
  /** Exactly what the model was shown. Omissions belong here too, as absences. */
  readonly contextMessageIds?: readonly string[];
  readonly contextDocumentIds?: readonly string[];
}

export interface SaveAnalysisResult {
  readonly analysis: Analysis;
  /** True when `triggerKey` already had an analysis and this call stored nothing. */
  readonly existing: boolean;
}

/**
 * Persist one analysis, idempotently by `triggerKey`.
 *
 * A restarted job re-enters with the same trigger key and gets the stored result back
 * with `existing: true`, instead of paying a provider for a second opinion on the same
 * input — and instead of leaving two differing assessments of one event in the record.
 *
 * The result is re-validated against `CaseAnalysisSchema` on the way in. It was already
 * validated where the model answered; validating again here means nothing reaches the
 * column that a reader could not parse back out.
 *
 * Cross-case ownership (`analyses.case_id` must equal the conversation's) is enforced
 * by `analyses_conversation_case_fkey`.
 */
export async function saveAnalysis(
  tx: DbTx,
  input: SaveAnalysisInput,
): Promise<SaveAnalysisResult> {
  const result = CaseAnalysisSchema.parse(input.result);

  const inserted = await tx
    .insert(analyses)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      caseId: input.caseId,
      conversationId: input.conversationId,
      triggerKey: input.triggerKey,
      result,
      status: input.status,
      model: input.model,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion ?? CASE_ANALYSIS_SCHEMA_VERSION,
      contextMessageIds: [...(input.contextMessageIds ?? [])],
      contextDocumentIds: [...(input.contextDocumentIds ?? [])],
    })
    .onConflictDoNothing({ target: analyses.triggerKey })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow) {
    return { analysis: toAnalysis(insertedRow), existing: false };
  }

  // The conflict target is unique, so the row is there.
  const existingRows = await tx
    .select()
    .from(analyses)
    .where(eq(analyses.triggerKey, input.triggerKey))
    .limit(1);
  return { analysis: toAnalysis(existingRows[0]!), existing: true };
}

export async function findAnalysisById(
  executor: DbExecutor,
  analysisId: string,
): Promise<Analysis | null> {
  const rows = await executor.select().from(analyses).where(eq(analyses.id, analysisId)).limit(1);
  const row = rows[0];
  return row ? toAnalysis(row) : null;
}

/** The short-circuit a restarting job uses before calling a provider at all. */
export async function findAnalysisByTriggerKey(
  executor: DbExecutor,
  triggerKey: string,
): Promise<Analysis | null> {
  const rows = await executor
    .select()
    .from(analyses)
    .where(eq(analyses.triggerKey, triggerKey))
    .limit(1);
  const row = rows[0];
  return row ? toAnalysis(row) : null;
}

export async function getLatestCaseAnalysis(
  executor: DbExecutor,
  caseId: string,
): Promise<Analysis | null> {
  const rows = await executor
    .select()
    .from(analyses)
    .where(eq(analyses.caseId, caseId))
    .orderBy(desc(analyses.createdAt), desc(analyses.id))
    .limit(1);
  const row = rows[0];
  return row ? toAnalysis(row) : null;
}
