import { randomUUID } from 'node:crypto';
import type {
  CaseContext,
  CaseRef,
  CaseStore,
  InboundMessageInput,
  JobQueue,
  Person,
  ResolveResult,
  SavedAnalysis,
  StoredDocument,
  StoredMessage,
  Urgency,
  RetrievedDocumentChunk,
} from './ports.js';

/** In-memory CaseStore/JobQueue for tests and for running the pipeline before Postgres exists. Fictional data only. */
export class MemoryStore implements CaseStore {
  people: Person[] = [];
  cases: (CaseRef & { clientId: string; lawyerId: string | null; open: boolean })[] = [];
  messages: (StoredMessage & { providerMessageId?: string })[] = [];
  documents: StoredDocument[] = [];
  analyses: (SavedAnalysis & { id: string })[] = [];
  outbound: {
    id: string;
    caseId: string;
    personId: string;
    text: string;
    purpose: string;
    analysisId?: string;
    status?: string;
    providerMessageId?: string;
    error?: string;
  }[] = [];
  documentChunks: {
    documentId: string;
    chunkIndex: number;
    content: string;
    embedding: number[];
  }[] = [];

  static seeded(): MemoryStore {
    const s = new MemoryStore();
    s.people.push(
      {
        id: 'p-client',
        displayName: 'Sarah Miller (fictional)',
        phoneE164: '+33600000001',
        role: 'client',
      },
      {
        id: 'p-lawyer',
        displayName: 'John Smith (fictional)',
        phoneE164: '+33600000002',
        role: 'lawyer',
      },
    );
    s.cases.push({
      id: 'c-1',
      title: 'Fictional criminal case',
      jurisdiction: 'FR',
      language: 'en',
      timezone: 'Europe/Paris',
      clientId: 'p-client',
      lawyerId: 'p-lawyer',
      open: true,
    });
    return s;
  }

  /**
   * Open intake: a number the firm has never seen gets its own case, assigned to the seeded lawyer.
   * Memory store only (the Postgres store will own this in packages/db). The display name never holds the number.
   */
  async isLawyer(phone: string) {
    return this.people.some((person) => person.role === 'lawyer' && person.phoneE164 === phone);
  }

  async countInboundMessages(caseId: string) {
    return this.messages.filter(
      (message) => message.caseId === caseId && message.direction === 'inbound',
    ).length;
  }

  async countOpenCases() {
    return this.cases.filter((caseRecord) => caseRecord.open).length;
  }

  async openIntakeCase(phone: string): Promise<{ caseId: string; person: Person }> {
    const n = this.cases.length + 1;
    const person: Person = {
      id: `p-intake-${n}`,
      displayName: `Contact WhatsApp n°${n}`,
      phoneE164: phone,
      role: 'client',
    };
    const lawyer = this.people.find((p) => p.role === 'lawyer') ?? null;
    this.people.push(person);
    const caseId = `c-${n}`;
    this.cases.push({
      id: caseId,
      title: `Accueil WhatsApp n°${n}`,
      jurisdiction: 'FR',
      language: 'fr',
      timezone: 'Europe/Paris',
      clientId: person.id,
      lawyerId: lawyer?.id ?? null,
      open: true,
    });
    return { caseId, person };
  }

  async resolveParticipant(phone: string): Promise<ResolveResult> {
    const person = this.people.find((p) => p.phoneE164 === phone);
    if (!person) return { kind: 'absent' };
    const open = this.cases.filter(
      (c) => c.open && (c.clientId === person.id || c.lawyerId === person.id),
    );
    if (open.length === 0) return { kind: 'absent' };
    if (open.length > 1) return { kind: 'ambiguous' };
    return { kind: 'found', person, caseId: open[0]!.id };
  }

  async saveInboundMessage(i: InboundMessageInput) {
    const existing = this.messages.find((m) => m.providerMessageId === i.providerMessageId);
    if (existing) return { message: existing, created: false };
    const message = {
      id: randomUUID(),
      caseId: i.caseId,
      conversationId: `conv-${i.caseId}`,
      personId: i.personId,
      direction: 'inbound' as const,
      kind: (i.media.length && !i.text ? 'document' : 'text') as StoredMessage['kind'],
      text: i.text,
      createdAt: i.receivedAt,
      providerMessageId: i.providerMessageId,
      media: i.media,
    };
    this.messages.push(message);
    return { message, created: true };
  }

  async setMessageTranscript(id: string, transcript: string) {
    const m = this.messages.find((x) => x.id === id);
    if (m) {
      m.text = transcript;
      m.kind = 'voice';
    }
  }

  async saveDocument(doc: Omit<StoredDocument, 'id'>) {
    const existing = this.documents.find(
      (item) => item.messageId === doc.messageId && item.mediaIndex === doc.mediaIndex,
    );
    if (existing) {
      Object.assign(existing, doc);
      return existing;
    }
    const d = { ...doc, id: randomUUID() };
    this.documents.push(d);
    return d;
  }

  async replaceDocumentChunks(
    documentId: string,
    chunks: { content: string; embedding: number[] }[],
    _model?: string,
  ) {
    this.documentChunks = this.documentChunks.filter((chunk) => chunk.documentId !== documentId);
    this.documentChunks.push(
      ...chunks.map((chunk, chunkIndex) => ({ documentId, chunkIndex, ...chunk })),
    );
  }

  async markDocumentEmbeddingFailed() {}

  async searchDocumentChunks(input: {
    caseId: string;
    conversationId: string;
    limit?: number;
  }): Promise<RetrievedDocumentChunk[]> {
    const allowed = new Set(
      this.documents
        .filter((document) => document.caseId === input.caseId)
        .filter((document) =>
          this.messages.some(
            (message) =>
              message.id === document.messageId && message.conversationId === input.conversationId,
          ),
        )
        .map((document) => document.id),
    );
    return this.documentChunks
      .filter((chunk) => allowed.has(chunk.documentId))
      .slice(0, input.limit ?? 6)
      .map((chunk) => ({ ...chunk, similarity: 1 }));
  }

  async getMessage(id: string) {
    return this.messages.find((m) => m.id === id) ?? null;
  }

  async getCaseContext(caseId: string): Promise<CaseContext | null> {
    const c = this.cases.find((x) => x.id === caseId);
    if (!c) return null;
    const client = this.people.find((p) => p.id === c.clientId)!;
    const lawyer = this.people.find((p) => p.id === c.lawyerId) ?? null;
    const { clientId: _c, lawyerId: _l, open: _o, ...ref } = c;
    return {
      case: ref,
      client,
      lawyer,
      messages: this.messages.filter((m) => m.caseId === caseId),
      documents: this.documents.filter((d) => d.caseId === caseId),
    };
  }

  async saveAnalysis(a: SavedAnalysis) {
    const existing = this.analyses.find((x) => x.triggerKey === a.triggerKey);
    if (existing) return { analysisId: existing.id, created: false };
    const id = randomUUID();
    this.analyses.push({ ...a, id });
    return { analysisId: id, created: true };
  }

  async saveOutbound(input: {
    caseId: string;
    personId: string;
    text: string;
    purpose: 'lawyer_alert' | 'client_reply';
    analysisId?: string;
  }) {
    const id = randomUUID();
    this.outbound.push({ id, ...input });
    // What the client is told is part of the conversation the intake agent reads back.
    if (input.purpose === 'client_reply') {
      this.messages.push({
        id,
        caseId: input.caseId,
        conversationId: `conv-${input.caseId}`,
        personId: null,
        direction: 'outbound',
        kind: 'text',
        text: input.text,
        createdAt: new Date().toISOString(),
      });
    }
    return { messageId: id };
  }

  async getLatestAnalysis(caseId: string): Promise<unknown> {
    return this.analyses.filter((a) => a.caseId === caseId).at(-1)?.result ?? null;
  }

  async lastAlertedUrgency(caseId: string): Promise<Urgency | null> {
    const rank: Urgency[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    let best: Urgency | null = null;
    for (const o of this.outbound) {
      if (
        o.caseId !== caseId ||
        o.purpose !== 'lawyer_alert' ||
        (o.status !== 'sent' && o.status !== 'simulated')
      )
        continue;
      const result = this.analyses.find((a) => a.id === o.analysisId)?.result as
        | { analysis?: { urgency?: Urgency } }
        | undefined;
      const u = result?.analysis?.urgency;
      if (u && (best === null || rank.indexOf(u) > rank.indexOf(best))) best = u;
    }
    return best;
  }

  async markOutbound(
    id: string,
    status: 'sent' | 'failed' | 'simulated',
    providerMessageId?: string,
    error?: string,
  ) {
    const o = this.outbound.find((x) => x.id === id);
    if (o) Object.assign(o, { status, providerMessageId, error });
  }
}

export class MemoryQueue implements JobQueue {
  jobs: { name: string; payload: { messageId: string } }[] = [];
  async enqueue(name: 'process-inbound', payload: { messageId: string }) {
    this.jobs.push({ name, payload });
  }
}
