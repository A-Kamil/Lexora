import { eq } from 'drizzle-orm';
import { toIsoDateTime, type Escalation, type EscalationStatus } from '@lexora/shared';
import type { DbExecutor, DbTx } from './client.js';
import { escalations } from './schema.js';

type EscalationRow = typeof escalations.$inferSelect;

export function toEscalation(row: EscalationRow): Escalation {
  return {
    id: row.id,
    caseId: row.caseId,
    analysisId: row.analysisId,
    lawyerId: row.lawyerId,
    outboundMessageId: row.outboundMessageId,
    status: row.status,
    reason: row.reason,
    providerMessageId: row.providerMessageId,
    errorCode: row.errorCode,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

export interface SaveEscalationInput {
  readonly id?: string;
  readonly caseId: string;
  readonly analysisId: string;
  /** Null means the case has no assigned lawyer: pair with `blocked_no_lawyer`. */
  readonly lawyerId?: string | null;
  readonly outboundMessageId?: string | null;
  readonly status?: EscalationStatus;
  /** Why this analysis escalated. Required: an alert with no stated cause is not useful. */
  readonly reason: string;
  readonly providerMessageId?: string | null;
  readonly errorCode?: string | null;
}

export interface SaveEscalationResult {
  readonly escalation: Escalation;
  /** True when this analysis had already escalated and this call stored nothing. */
  readonly existing: boolean;
}

/**
 * Create the escalation for an analysis, at most once.
 *
 * `escalations_analysis_id_key` is the entire duplicate-alert defense: a retried job
 * gets the existing row back rather than queueing a second message to the lawyer. It
 * holds under concurrency, which a read-then-write check would not.
 *
 * Status starts `pending`. Nothing here sends anything, and `accepted` is never
 * written as a synonym for `delivered`.
 */
export async function saveEscalation(
  tx: DbTx,
  input: SaveEscalationInput,
): Promise<SaveEscalationResult> {
  const inserted = await tx
    .insert(escalations)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      caseId: input.caseId,
      analysisId: input.analysisId,
      lawyerId: input.lawyerId ?? null,
      outboundMessageId: input.outboundMessageId ?? null,
      status: input.status ?? 'pending',
      reason: input.reason,
      providerMessageId: input.providerMessageId ?? null,
      errorCode: input.errorCode ?? null,
    })
    .onConflictDoNothing({ target: escalations.analysisId })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow) {
    return { escalation: toEscalation(insertedRow), existing: false };
  }

  const existingRows = await tx
    .select()
    .from(escalations)
    .where(eq(escalations.analysisId, input.analysisId))
    .limit(1);
  return { escalation: toEscalation(existingRows[0]!), existing: true };
}

export async function findEscalationByAnalysisId(
  executor: DbExecutor,
  analysisId: string,
): Promise<Escalation | null> {
  const rows = await executor
    .select()
    .from(escalations)
    .where(eq(escalations.analysisId, analysisId))
    .limit(1);
  const row = rows[0];
  return row ? toEscalation(row) : null;
}

export interface UpdateEscalationInput {
  readonly status: EscalationStatus;
  readonly outboundMessageId?: string | null;
  readonly providerMessageId?: string | null;
  readonly errorCode?: string | null;
}

/**
 * Record an escalation's outcome.
 *
 * Monotonicity of the delivery lifecycle — a `delivered` result must not later be
 * overwritten by a late `accepted` callback — is the send pipeline's job in Task 6,
 * not this write's. This function stores what it is told.
 */
export async function updateEscalation(
  executor: DbExecutor,
  escalationId: string,
  input: UpdateEscalationInput,
): Promise<void> {
  await executor
    .update(escalations)
    .set({
      status: input.status,
      ...(input.outboundMessageId === undefined
        ? {}
        : { outboundMessageId: input.outboundMessageId }),
      ...(input.providerMessageId === undefined
        ? {}
        : { providerMessageId: input.providerMessageId }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      updatedAt: new Date(),
    })
    .where(eq(escalations.id, escalationId));
}
