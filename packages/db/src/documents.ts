import { and, asc, eq } from 'drizzle-orm';
import {
  toIsoDateTime,
  type Document,
  type DocumentMetadata,
  type DocumentReference,
  type DocumentStatus,
} from '@lexora/shared';
import type { DbExecutor, DbTx } from './client.js';
import { documents } from './schema.js';

type DocumentRow = typeof documents.$inferSelect;

export function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    caseId: row.caseId,
    messageId: row.messageId,
    mediaIndex: row.mediaIndex,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    status: row.status,
    extractedText: row.extractedText,
    metadata: row.metadata,
    errorCode: row.errorCode,
    createdAt: toIsoDateTime(row.createdAt),
    updatedAt: toIsoDateTime(row.updatedAt),
  };
}

/**
 * The shape `CaseContext` exposes.
 *
 * Carries no `storageKey` and no `extractedText`: a context object is passed around,
 * logged near, and serialized, so it must not contain a private object key or a
 * document body. `extractedTextLength` lets a caller say "two documents reviewed,
 * 4,200 characters" without holding the text.
 */
export function toDocumentReference(row: DocumentRow): DocumentReference {
  return {
    id: row.id,
    messageId: row.messageId,
    mediaIndex: row.mediaIndex,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    documentType: row.metadata.documentType ?? null,
    summary: row.metadata.summary ?? null,
    extractedTextLength: row.extractedText?.length ?? 0,
    createdAt: toIsoDateTime(row.createdAt),
  };
}

/** The deterministic private object key for a document. A key, never a URL. */
export function buildStorageKey(caseId: string, documentId: string): string {
  return `${caseId}/${documentId}/original`;
}

export interface SaveDocumentPlaceholderInput {
  /**
   * Supplied by the caller, because the storage key embeds it. Generating the id up
   * front is what makes the key deterministic and a retried upload recoverable.
   */
  readonly id: string;
  readonly caseId: string;
  readonly messageId: string;
  readonly mediaIndex: number;
  readonly mimeType: string;
  readonly storageKey?: string;
}

/**
 * Record that an attachment exists, before any of its bytes have been fetched.
 *
 * A placeholder is created in the same transaction as its message, so acknowledging a
 * webhook never loses track of an attachment. It starts `pending` with no size, digest
 * or text; `documents_stored_has_bytes` keeps it from claiming `stored` until those
 * are known.
 *
 * `documents_message_id_media_index_key` makes a replayed intake find the existing
 * placeholder rather than create a second one for the same slot.
 */
export async function saveDocumentPlaceholder(
  tx: DbTx,
  input: SaveDocumentPlaceholderInput,
): Promise<Document> {
  const rows = await tx
    .insert(documents)
    .values({
      id: input.id,
      caseId: input.caseId,
      messageId: input.messageId,
      mediaIndex: input.mediaIndex,
      mimeType: input.mimeType,
      storageKey: input.storageKey ?? buildStorageKey(input.caseId, input.id),
      status: 'pending',
    })
    .returning();
  return toDocument(rows[0]!);
}

export async function findDocumentById(
  executor: DbExecutor,
  documentId: string,
): Promise<Document | null> {
  const rows = await executor.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  const row = rows[0];
  return row ? toDocument(row) : null;
}

/** Every document on a case, whatever its state, oldest first. */
export async function getCaseDocuments(executor: DbExecutor, caseId: string): Promise<Document[]> {
  const rows = await executor
    .select()
    .from(documents)
    .where(eq(documents.caseId, caseId))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  return rows.map(toDocument);
}

/** Only the documents whose text is actually available. */
export async function getReadyCaseDocuments(
  executor: DbExecutor,
  caseId: string,
): Promise<Document[]> {
  const rows = await executor
    .select()
    .from(documents)
    .where(and(eq(documents.caseId, caseId), eq(documents.status, 'ready')))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  return rows.map(toDocument);
}

export interface UpdateDocumentStateInput {
  readonly status: DocumentStatus;
  readonly byteSize?: number | null;
  readonly sha256?: string | null;
  readonly extractedText?: string | null;
  readonly metadata?: DocumentMetadata;
  readonly errorCode?: string | null;
  readonly originalBytes?: Uint8Array | null;
  readonly originalFilename?: string | null;
  readonly indexedAt?: Date | null;
  readonly embeddingError?: string | null;
}

/**
 * Advance a document through `pending → stored → extracting → ready`, or park it in
 * `rejected` / `failed`.
 *
 * The state machine's consistency is enforced by check constraints rather than here:
 * a `ready` row must carry text, a terminal row must carry a reason, and a row past
 * `pending` must carry a size and digest. Storage and extraction are Task 7; this
 * write exists so the seed and the tests can exercise every state now.
 */
export async function updateDocumentState(
  executor: DbExecutor,
  documentId: string,
  input: UpdateDocumentStateInput,
): Promise<void> {
  await executor
    .update(documents)
    .set({
      status: input.status,
      ...(input.byteSize === undefined ? {} : { byteSize: input.byteSize }),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.extractedText === undefined ? {} : { extractedText: input.extractedText }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      ...(input.originalBytes === undefined ? {} : { originalBytes: input.originalBytes }),
      ...(input.originalFilename === undefined ? {} : { originalFilename: input.originalFilename }),
      ...(input.indexedAt === undefined ? {} : { indexedAt: input.indexedAt }),
      ...(input.embeddingError === undefined ? {} : { embeddingError: input.embeddingError }),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId));
}

export interface SaveProcessedDocumentInput {
  readonly id?: string;
  readonly caseId: string;
  readonly messageId: string;
  readonly mediaIndex: number;
  readonly mimeType: string;
  readonly originalBytes: Uint8Array;
  readonly originalFilename: string;
  readonly sha256: string;
  readonly status: 'pending' | 'ready' | 'failed';
  readonly extractedText: string | null;
  readonly metadata?: DocumentMetadata;
  readonly errorCode?: string | null;
}

/** Store the private original and OCR result in one idempotent row per message attachment. */
export async function saveProcessedDocument(
  executor: DbExecutor,
  input: SaveProcessedDocumentInput,
): Promise<Document> {
  const id = input.id ?? crypto.randomUUID();
  const rows = await executor
    .insert(documents)
    .values({
      id,
      caseId: input.caseId,
      messageId: input.messageId,
      mediaIndex: input.mediaIndex,
      storageKey: buildStorageKey(input.caseId, id),
      mimeType: input.mimeType,
      byteSize: input.originalBytes.byteLength,
      sha256: input.sha256,
      status: input.status,
      extractedText: input.extractedText,
      metadata: input.metadata ?? {},
      errorCode: input.errorCode ?? null,
      originalBytes: input.originalBytes,
      originalFilename: input.originalFilename,
    })
    .onConflictDoUpdate({
      target: [documents.messageId, documents.mediaIndex],
      set: {
        mimeType: input.mimeType,
        byteSize: input.originalBytes.byteLength,
        sha256: input.sha256,
        status: input.status,
        extractedText: input.extractedText,
        metadata: input.metadata ?? {},
        errorCode: input.errorCode ?? null,
        originalBytes: input.originalBytes,
        originalFilename: input.originalFilename,
        indexedAt: null,
        embeddingError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return toDocument(rows[0]!);
}
