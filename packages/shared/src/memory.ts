import { randomUUID } from 'node:crypto';
import type {
  CaseContext, CaseRef, CaseStore, InboundMessageInput, JobQueue, Person, ResolveResult,
  SavedAnalysis, StoredDocument, StoredMessage,
} from './ports.js';

/** In-memory CaseStore/JobQueue for tests and for running the pipeline before Postgres exists. Fictional data only. */
export class MemoryStore implements CaseStore {
  people: Person[] = [];
  cases: (CaseRef & { clientId: string; lawyerId: string | null; open: boolean })[] = [];
  messages: (StoredMessage & { providerMessageId?: string })[] = [];
  documents: StoredDocument[] = [];
  analyses: (SavedAnalysis & { id: string })[] = [];
  outbound: { id: string; caseId: string; personId: string; text: string; purpose: string; analysisId?: string; status?: string; providerMessageId?: string; error?: string }[] = [];

  static seeded(): MemoryStore {
    const s = new MemoryStore();
    s.people.push(
      { id: 'p-client', displayName: 'Sarah Miller (fictional)', phoneE164: '+33600000001', role: 'client' },
      { id: 'p-lawyer', displayName: 'John Smith (fictional)', phoneE164: '+33600000002', role: 'lawyer' },
    );
    s.cases.push({ id: 'c-1', title: 'Fictional criminal case', jurisdiction: 'FR', language: 'en', timezone: 'Europe/Paris', clientId: 'p-client', lawyerId: 'p-lawyer', open: true });
    return s;
  }

  async resolveParticipant(phone: string): Promise<ResolveResult> {
    const person = this.people.find((p) => p.phoneE164 === phone);
    if (!person) return { kind: 'absent' };
    const open = this.cases.filter((c) => c.open && (c.clientId === person.id || c.lawyerId === person.id));
    if (open.length === 0) return { kind: 'absent' };
    if (open.length > 1) return { kind: 'ambiguous' };
    return { kind: 'found', person, caseId: open[0]!.id };
  }

  async saveInboundMessage(i: InboundMessageInput) {
    const existing = this.messages.find((m) => m.providerMessageId === i.providerMessageId);
    if (existing) return { message: existing, created: false };
    const message = { id: randomUUID(), caseId: i.caseId, conversationId: `conv-${i.caseId}`, personId: i.personId, direction: 'inbound' as const,
      kind: (i.media.length && !i.text ? 'document' : 'text') as StoredMessage['kind'], text: i.text, createdAt: i.receivedAt, providerMessageId: i.providerMessageId, media: i.media };
    this.messages.push(message);
    return { message, created: true };
  }

  async setMessageTranscript(id: string, transcript: string) {
    const m = this.messages.find((x) => x.id === id);
    if (m) { m.text = transcript; m.kind = 'voice'; }
  }

  async saveDocument(doc: Omit<StoredDocument, 'id'>) {
    const d = { ...doc, id: randomUUID() };
    this.documents.push(d);
    return d;
  }

  async getMessage(id: string) { return this.messages.find((m) => m.id === id) ?? null; }

  async getCaseContext(caseId: string): Promise<CaseContext | null> {
    const c = this.cases.find((x) => x.id === caseId);
    if (!c) return null;
    const client = this.people.find((p) => p.id === c.clientId)!;
    const lawyer = this.people.find((p) => p.id === c.lawyerId) ?? null;
    const { clientId: _c, lawyerId: _l, open: _o, ...ref } = c;
    return { case: ref, client, lawyer, messages: this.messages.filter((m) => m.caseId === caseId), documents: this.documents.filter((d) => d.caseId === caseId) };
  }

  async saveAnalysis(a: SavedAnalysis) {
    const existing = this.analyses.find((x) => x.triggerKey === a.triggerKey);
    if (existing) return { analysisId: existing.id, created: false };
    const id = randomUUID();
    this.analyses.push({ ...a, id });
    return { analysisId: id, created: true };
  }

  async saveOutbound(input: { caseId: string; personId: string; text: string; purpose: 'lawyer_alert' | 'client_reply'; analysisId?: string }) {
    const id = randomUUID();
    this.outbound.push({ id, ...input });
    return { messageId: id };
  }

  async markOutbound(id: string, status: 'sent' | 'failed' | 'simulated', providerMessageId?: string, error?: string) {
    const o = this.outbound.find((x) => x.id === id);
    if (o) Object.assign(o, { status, providerMessageId, error });
  }
}

export class MemoryQueue implements JobQueue {
  jobs: { name: string; payload: { messageId: string } }[] = [];
  async enqueue(name: 'process-inbound', payload: { messageId: string }) { this.jobs.push({ name, payload }); }
}
