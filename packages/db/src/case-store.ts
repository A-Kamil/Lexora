import { createHash, randomUUID } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';
import { CaseAnalysisSchema } from '@lexora/shared';
import type {
  CaseContext,
  CaseStore,
  InboundMedia,
  InboundMessageInput,
  Person,
  ResolveResult,
  SavedAnalysis,
  StoredDocument,
  StoredMessage,
  Urgency,
} from '@lexora/shared/pipeline';
import type { Database } from './client.js';
import { withTransaction } from './client.js';
import { getActiveCase, findCaseById, getCaseMembers } from './cases.js';
import { createConversation, findOpenWhatsappConversation } from './conversations.js';
import {
  getCaseDocuments,
  saveDocumentPlaceholder,
  saveProcessedDocument,
  updateDocumentState,
} from './documents.js';
import {
  markDocumentEmbeddingFailed,
  replaceDocumentChunks,
  searchDocumentChunks,
} from './document-chunks.js';
import { getLatestCaseAnalysis, saveAnalysis } from './analyses.js';
import { findMessageByProviderId, saveMessage } from './messages.js';
import { findPersonById, findPersonByPhone, touchWhatsappInbound } from './people.js';
import { analyses, caseMembers, cases, messages, people } from './schema.js';

function personForPipeline(person: Awaited<ReturnType<typeof findPersonById>>): Person {
  if (!person) throw new Error('person not found');
  return {
    id: person.id,
    displayName: person.displayName,
    phoneE164: person.phoneE164,
    role: person.role,
  };
}

function mediaFrom(metadata: Record<string, unknown>): InboundMedia[] {
  const value = metadata.media;
  return Array.isArray(value) ? (value as InboundMedia[]) : [];
}

function messageForPipeline(row: typeof messages.$inferSelect): StoredMessage {
  const voice = row.metadata.voice === true;
  return {
    id: row.id,
    caseId: row.caseId,
    conversationId: row.conversationId,
    personId: row.personId,
    direction: row.direction,
    kind: voice ? 'voice' : row.kind === 'media' ? 'document' : row.kind,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    media: mediaFrom(row.metadata),
  };
}

/** Thin adapter that lets the existing WhatsApp worker use the PostgreSQL domain layer. */
export class PostgresCaseStore implements CaseStore {
  constructor(private readonly db: Database) {}

  async isLawyer(phoneE164: string): Promise<boolean> {
    return (await findPersonByPhone(this.db, phoneE164))?.role === 'lawyer';
  }

  async countOpenCases(): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(cases)
      .where(eq(cases.status, 'open'));
    return rows[0]?.value ?? 0;
  }

  async countInboundMessages(caseId: string): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(messages)
      .where(and(eq(messages.caseId, caseId), eq(messages.direction, 'inbound')));
    return rows[0]?.value ?? 0;
  }

  async openIntakeCase(phoneE164: string): Promise<{ caseId: string; person: Person }> {
    return withTransaction(this.db, async (tx) => {
      const existing = await findPersonByPhone(tx, phoneE164);
      const personRows = existing
        ? []
        : await tx
            .insert(people)
            .values({
              displayName: 'Contact WhatsApp',
              phoneE164,
              role: 'client',
              enrolledAt: new Date(),
            })
            .returning();
      const client = existing ?? personRows[0]!;
      const caseRows = await tx
        .insert(cases)
        .values({
          title: 'Accueil WhatsApp',
          jurisdiction: 'FR',
          language: 'fr',
          timezone: 'Europe/Paris',
        })
        .returning();
      const caseId = caseRows[0]!.id;
      await tx
        .insert(caseMembers)
        .values({ caseId, personId: client.id, role: 'client', isPrimary: true });
      const lawyerRows = await tx
        .select()
        .from(people)
        .where(eq(people.role, 'lawyer'))
        .orderBy(asc(people.createdAt))
        .limit(1);
      const lawyer = lawyerRows[0];
      if (lawyer) {
        await tx
          .insert(caseMembers)
          .values({ caseId, personId: lawyer.id, role: 'lawyer', isPrimary: true });
      }
      await createConversation(tx, { caseId, personId: client.id, channel: 'whatsapp' });
      return { caseId, person: personForPipeline(await findPersonById(tx, client.id)) };
    });
  }

  async resolveParticipant(phoneE164: string): Promise<ResolveResult> {
    const person = await findPersonByPhone(this.db, phoneE164);
    if (!person) return { kind: 'absent' };
    const active = await getActiveCase(this.db, person.id);
    if (active.kind === 'none') return { kind: 'absent' };
    if (active.kind === 'ambiguous') return { kind: 'ambiguous' };
    return { kind: 'found', person: personForPipeline(person), caseId: active.case.id };
  }

  async saveInboundMessage(input: InboundMessageInput) {
    const existing = await findMessageByProviderId(
      this.db,
      input.provider,
      input.providerMessageId,
    );
    if (existing) {
      const rows = await this.db
        .select()
        .from(messages)
        .where(eq(messages.id, existing.id))
        .limit(1);
      return { message: messageForPipeline(rows[0]!), created: false };
    }
    return withTransaction(this.db, async (tx) => {
      const conversation =
        (await findOpenWhatsappConversation(tx, input.caseId, input.personId)) ??
        (await createConversation(tx, {
          caseId: input.caseId,
          personId: input.personId,
          channel: 'whatsapp',
        }));
      const saved = await saveMessage(tx, {
        caseId: input.caseId,
        conversationId: conversation.id,
        personId: input.personId,
        direction: 'inbound',
        kind: input.media.length ? 'media' : 'text',
        text: input.text,
        provider: input.provider,
        providerMessageId: input.providerMessageId,
        metadata: { media: input.media },
        createdAt: new Date(input.receivedAt),
      });
      await touchWhatsappInbound(tx, input.personId, new Date(input.receivedAt));
      const rows = await tx.select().from(messages).where(eq(messages.id, saved.id)).limit(1);
      return { message: messageForPipeline(rows[0]!), created: true };
    });
  }

  async setMessageTranscript(messageId: string, transcript: string): Promise<void> {
    const rows = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    const row = rows[0];
    if (!row) return;
    await this.db
      .update(messages)
      .set({ text: transcript, metadata: { ...row.metadata, voice: true }, updatedAt: new Date() })
      .where(eq(messages.id, messageId));
  }

  async saveDocument(input: Omit<StoredDocument, 'id'>): Promise<StoredDocument> {
    const bytes = input.originalBytes;
    if (bytes) {
      const row = await saveProcessedDocument(this.db, {
        caseId: input.caseId,
        messageId: input.messageId,
        mediaIndex: input.mediaIndex ?? 0,
        mimeType: input.mimeType,
        originalBytes: bytes,
        originalFilename: input.originalFilename ?? 'document',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        status: input.status,
        extractedText: input.extractedText,
        metadata: {
          ...(input.documentType ? { documentType: input.documentType } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
        },
        ...(input.status === 'failed' ? { errorCode: 'processing_failed' } : {}),
      });
      return { ...input, id: row.id };
    }
    const id = randomUUID();
    const row = await withTransaction(this.db, (tx) =>
      saveDocumentPlaceholder(tx, {
        id,
        caseId: input.caseId,
        messageId: input.messageId,
        mediaIndex: input.mediaIndex ?? 0,
        mimeType: input.mimeType,
      }),
    );
    await updateDocumentState(this.db, row.id, { status: 'failed', errorCode: 'download_failed' });
    return { ...input, id: row.id };
  }

  async getMessage(messageId: string): Promise<StoredMessage | null> {
    const rows = await this.db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    return rows[0] ? messageForPipeline(rows[0]) : null;
  }

  async getCaseContext(caseId: string): Promise<CaseContext | null> {
    const caseRecord = await findCaseById(this.db, caseId);
    if (!caseRecord) return null;
    const members = await getCaseMembers(this.db, caseId);
    const clientMember =
      members.find((member) => member.role === 'client' && member.isPrimary) ??
      members.find((member) => member.role === 'client');
    if (!clientMember) return null;
    const lawyerMember =
      members.find((member) => member.role === 'lawyer' && member.isPrimary) ??
      members.find((member) => member.role === 'lawyer');
    const [client, lawyer, messageRows, documentRows] = await Promise.all([
      findPersonById(this.db, clientMember.personId),
      lawyerMember ? findPersonById(this.db, lawyerMember.personId) : Promise.resolve(null),
      this.db
        .select()
        .from(messages)
        .where(eq(messages.caseId, caseId))
        .orderBy(asc(messages.createdAt), asc(messages.id)),
      getCaseDocuments(this.db, caseId),
    ]);
    return {
      case: {
        id: caseRecord.id,
        title: caseRecord.title,
        jurisdiction: caseRecord.jurisdiction,
        language: caseRecord.language,
        timezone: caseRecord.timezone,
      },
      client: personForPipeline(client),
      lawyer: lawyer ? personForPipeline(lawyer) : null,
      messages: messageRows.map(messageForPipeline),
      documents: documentRows.map((document) => ({
        id: document.id,
        caseId: document.caseId,
        messageId: document.messageId,
        mediaIndex: document.mediaIndex,
        mimeType: document.mimeType,
        status:
          document.status === 'ready'
            ? 'ready'
            : document.status === 'failed' || document.status === 'rejected'
              ? 'failed'
              : 'pending',
        extractedText: document.extractedText,
        documentType: document.metadata.documentType ?? null,
        summary: document.metadata.summary ?? null,
      })),
    };
  }

  async saveAnalysis(input: SavedAnalysis) {
    const envelope = input.result as {
      analysis?: unknown;
      includedMessageIds?: string[];
      includedDocumentIds?: string[];
    };
    const result = CaseAnalysisSchema.parse(envelope.analysis ?? input.result);
    const saved = await withTransaction(this.db, (tx) =>
      saveAnalysis(tx, {
        caseId: input.caseId,
        conversationId: input.conversationId,
        triggerKey: input.triggerKey,
        status: input.status,
        model: input.model || 'none',
        promptVersion: 'v1',
        result,
        contextMessageIds: envelope.includedMessageIds ?? [],
        contextDocumentIds: envelope.includedDocumentIds ?? [],
      }),
    );
    return { analysisId: saved.analysis.id, created: !saved.existing };
  }

  async saveOutbound(input: {
    caseId: string;
    personId: string;
    text: string;
    purpose: 'lawyer_alert' | 'client_reply';
    analysisId?: string;
  }) {
    const conversation =
      (await findOpenWhatsappConversation(this.db, input.caseId, input.personId)) ??
      (await createConversation(this.db, {
        caseId: input.caseId,
        personId: input.personId,
        channel: 'whatsapp',
      }));
    const message = await withTransaction(this.db, (tx) =>
      saveMessage(tx, {
        caseId: input.caseId,
        conversationId: conversation.id,
        direction: 'outbound',
        kind: 'text',
        text: input.text,
        deliveryStatus: 'pending',
        metadata: {
          purpose: input.purpose,
          ...(input.analysisId ? { analysisId: input.analysisId } : {}),
        },
      }),
    );
    return { messageId: message.id };
  }

  async markOutbound(
    messageId: string,
    status: 'sent' | 'failed' | 'simulated',
    providerMessageId?: string,
    error?: string,
  ): Promise<void> {
    const current = await this.db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    await this.db
      .update(messages)
      .set({
        deliveryStatus: status === 'sent' ? 'accepted' : status,
        providerMessageId: providerMessageId ?? null,
        metadata: { ...(current[0]?.metadata ?? {}), ...(error ? { error } : {}) },
        updatedAt: new Date(),
      })
      .where(eq(messages.id, messageId));
  }

  async getLatestAnalysis(caseId: string): Promise<unknown> {
    const analysis = await getLatestCaseAnalysis(this.db, caseId);
    return analysis ? { analysis: analysis.result } : null;
  }

  async lastAlertedUrgency(caseId: string): Promise<Urgency | null> {
    const analysisRows = await this.db.select().from(analyses).where(eq(analyses.caseId, caseId));
    const sentRows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.caseId, caseId), eq(messages.direction, 'outbound')));
    const sentIds = new Set(
      sentRows
        .filter((row) => ['accepted', 'delivered', 'simulated'].includes(row.deliveryStatus))
        .map((row) => row.metadata.analysisId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const rank: Urgency[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    return (
      analysisRows
        .filter((row) => sentIds.has(row.id))
        .map((row) => row.result.urgency)
        .sort((a, b) => rank.indexOf(b) - rank.indexOf(a))[0] ?? null
    );
  }

  replaceDocumentChunks(
    documentId: string,
    chunks: { content: string; embedding: number[] }[],
    model: string,
  ) {
    return withTransaction(this.db, (tx) => replaceDocumentChunks(tx, documentId, chunks, model));
  }

  markDocumentEmbeddingFailed(documentId: string, error: string) {
    return markDocumentEmbeddingFailed(this.db, documentId, error);
  }

  searchDocumentChunks(input: {
    caseId: string;
    conversationId: string;
    embedding: number[];
    limit?: number;
  }) {
    return searchDocumentChunks(this.db, input);
  }
}
