import { and, asc, eq, sql } from 'drizzle-orm';
import { cosineDistance } from 'drizzle-orm/sql/functions/vector';
import type { DbExecutor, DbTx } from './client.js';
import { documentChunks, documents, messages } from './schema.js';

export interface DocumentChunkInput {
  readonly content: string;
  readonly embedding: number[];
}

export interface RetrievedDocumentChunk {
  readonly documentId: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly similarity: number;
}

function assertEmbedding(embedding: number[]): void {
  if (embedding.length !== 1024 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error('embedding must contain 1024 finite numbers');
  }
}

/** Delete then insert within one transaction so retries never leave duplicate/stale chunks. */
export async function replaceDocumentChunks(
  tx: DbTx,
  documentId: string,
  chunks: DocumentChunkInput[],
  model = 'mistral-embed',
): Promise<void> {
  for (const chunk of chunks) assertEmbedding(chunk.embedding);
  await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  if (chunks.length) {
    await tx.insert(documentChunks).values(
      chunks.map((chunk, chunkIndex) => ({
        documentId,
        chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
        embeddingModel: model,
      })),
    );
  }
  await tx
    .update(documents)
    .set({ indexedAt: new Date(), embeddingError: null, updatedAt: new Date() })
    .where(eq(documents.id, documentId));
}

export async function markDocumentEmbeddingFailed(
  executor: DbExecutor,
  documentId: string,
  error: string,
): Promise<void> {
  await executor
    .update(documents)
    .set({ indexedAt: null, embeddingError: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(documents.id, documentId));
}

/** Similarity search is constrained by both case and conversation before LIMIT is applied. */
export async function searchDocumentChunks(
  executor: DbExecutor,
  input: {
    caseId: string;
    conversationId: string;
    embedding: number[];
    limit?: number;
  },
): Promise<RetrievedDocumentChunk[]> {
  assertEmbedding(input.embedding);
  const distance = cosineDistance(documentChunks.embedding, input.embedding);
  const rows = await executor
    .select({
      documentId: documentChunks.documentId,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      similarity: sql<number>`1 - (${distance})`,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .innerJoin(messages, eq(messages.id, documents.messageId))
    .where(
      and(eq(documents.caseId, input.caseId), eq(messages.conversationId, input.conversationId)),
    )
    .orderBy(asc(distance))
    .limit(Math.min(Math.max(input.limit ?? 6, 1), 20));
  return rows;
}
