/**
 * `@lexora/db` — the only place domain SQL lives.
 *
 * Applications import these functions and never build queries, so a change to the
 * schema has one place to be reflected. Drizzle itself is not re-exported: the
 * transaction handle is the opaque `DbTx`, obtained from `withTransaction`.
 *
 * `schema` is exported for migration generation and for tests that assert on
 * constraints; application code should not need it.
 */

export {
  createDb,
  readDatabaseUrl,
  withTransaction,
  MissingDatabaseUrlError,
  type CreateDbOptions,
  type Database,
  type DbExecutor,
  type DbHandle,
  type DbTx,
} from './client.js';

export {
  CaseNotFoundError,
  ConversationNotFoundError,
  InvalidTimeZoneError,
  MessageNotFoundError,
  OwnershipViolationError,
} from './errors.js';

export { findPersonById, findPersonByPhone, toPerson, touchWhatsappInbound } from './people.js';

export {
  findCaseById,
  getActiveCase,
  getCaseContext,
  getCaseMembers,
  getDeadlines,
  saveDeadline,
  toCase,
  toDeadline,
  type SaveDeadlineInput,
} from './cases.js';

export {
  createConversation,
  findConversationById,
  findOpenWhatsappConversation,
  saveConversationSummary,
  toConversation,
  type CreateConversationInput,
} from './conversations.js';

export {
  findMessageById,
  findMessageByProviderId,
  getCaseMessages,
  saveMessage,
  setMessageDeliveryStatus,
  toMessage,
  type GetCaseMessagesOptions,
  type SaveMessageInput,
} from './messages.js';

export {
  buildStorageKey,
  findDocumentById,
  getCaseDocuments,
  getReadyCaseDocuments,
  saveDocumentPlaceholder,
  saveProcessedDocument,
  toDocument,
  toDocumentReference,
  updateDocumentState,
  type SaveDocumentPlaceholderInput,
  type SaveProcessedDocumentInput,
  type UpdateDocumentStateInput,
} from './documents.js';

export {
  markDocumentEmbeddingFailed,
  replaceDocumentChunks,
  searchDocumentChunks,
  type DocumentChunkInput,
  type RetrievedDocumentChunk,
} from './document-chunks.js';

export {
  findAnalysisById,
  findAnalysisByTriggerKey,
  getLatestCaseAnalysis,
  saveAnalysis,
  toAnalysis,
  type SaveAnalysisInput,
  type SaveAnalysisResult,
} from './analyses.js';

export {
  findEscalationByAnalysisId,
  saveEscalation,
  toEscalation,
  updateEscalation,
  type SaveEscalationInput,
  type SaveEscalationResult,
  type UpdateEscalationInput,
} from './escalations.js';

export { applyMigrations } from './migrate.js';
export {
  SEED_CLIENT_PHONE,
  SEED_IDS,
  SEED_LAWYER_PHONE,
  seedDemoFixtures,
  type SeedResult,
} from './seed.js';

export * as schema from './schema.js';
export { PostgresCaseStore } from './case-store.js';
