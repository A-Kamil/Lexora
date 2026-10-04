/**
 * Contract between the intake pipeline (api webhook, worker) and storage/queue (packages/db).
 * The DB developer implements CaseStore and JobQueue on Postgres + pg-boss; until then, and in tests,
 * the in-memory implementations in ./memory.ts are used. Do not change a signature without telling everyone.
 */

export type Role = 'client' | 'lawyer';
export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Person { id: string; displayName: string; phoneE164: string; role: Role }
export interface CaseRef { id: string; title: string; jurisdiction: string; language: string; timezone: string }

export type ResolveResult =
  | { kind: 'found'; person: Person; caseId: string }
  | { kind: 'absent' }
  | { kind: 'ambiguous' };

export interface InboundMedia { index: number; url: string; contentType: string }

export interface InboundMessageInput {
  caseId: string;
  personId: string;
  provider: 'kapso' | 'test';
  providerMessageId: string; // WhatsApp message id (wamid), unique: duplicates must not create new work
  text: string;
  media: InboundMedia[];
  receivedAt: string; // ISO 8601
}

export interface StoredMessage {
  id: string; caseId: string; conversationId: string; personId: string | null;
  direction: 'inbound' | 'outbound'; kind: 'text' | 'voice' | 'document' | 'system';
  text: string; createdAt: string;
  media?: InboundMedia[]; // inbound attachments (voice notes, documents) still to process
}

export interface StoredDocument { id: string; caseId: string; messageId: string; mimeType: string; status: 'pending' | 'ready' | 'failed'; extractedText: string | null; documentType: string | null; summary?: string | null }

export interface CaseContext {
  case: CaseRef;
  client: Person;
  lawyer: Person | null; // primary lawyer, null if none assigned
  messages: StoredMessage[]; // chronological
  documents: StoredDocument[];
}

export interface SavedAnalysis {
  caseId: string; conversationId: string; triggerKey: string; // e.g. `message:${messageId}:v1`, unique
  status: 'ok' | 'fallback'; result: unknown; model: string;
}

export interface CaseStore {
  resolveParticipant(phoneE164: string): Promise<ResolveResult>;
  /** Idempotent on providerMessageId: returns the existing message with created=false on duplicates. */
  saveInboundMessage(input: InboundMessageInput): Promise<{ message: StoredMessage; created: boolean }>;
  /** Replace a voice message's text by its transcript (kind becomes 'voice'). */
  setMessageTranscript(messageId: string, transcript: string): Promise<void>;
  saveDocument(doc: Omit<StoredDocument, 'id'>): Promise<StoredDocument>;
  getMessage(messageId: string): Promise<StoredMessage | null>;
  getCaseContext(caseId: string): Promise<CaseContext | null>;
  /** Idempotent on triggerKey: returns the existing analysis id if already saved. */
  saveAnalysis(a: SavedAnalysis): Promise<{ analysisId: string; created: boolean }>;
  saveOutbound(input: { caseId: string; personId: string; text: string; purpose: 'lawyer_alert' | 'client_reply'; analysisId?: string }): Promise<{ messageId: string }>;
  markOutbound(messageId: string, status: 'sent' | 'failed' | 'simulated', providerMessageId?: string, error?: string): Promise<void>;
  /**
   * Highest urgency already delivered to the lawyer for this case, or null. Lets a conversation re-analyse every
   * message without re-alerting the lawyer each time. Optional: without it, every HIGH/CRITICAL message alerts.
   */
  lastAlertedUrgency?(caseId: string): Promise<Urgency | null>;
}

export interface JobQueue {
  enqueue(name: 'process-inbound', payload: { messageId: string }): Promise<void>;
}
