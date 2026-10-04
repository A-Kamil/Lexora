import type { FastifyInstance } from 'fastify';
import type { MemoryStore, StoredDocument } from '@lexora/shared/pipeline';

/**
 * Read API of the lawyer dashboard (apps/web), over the demo case store. Shapes follow apps/web/src/types/lexora.ts.
 * Exposed through the public tunnel like /demo: fictional demo data only, never phone numbers.
 */
type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
interface Analysis { issue: string; urgency: Urgency; urgencyReason: string; requiresLawyer: boolean; missingInformation: string[]; requestedDocuments: string[]; recommendedActions: string[] }
interface Result { analysis?: Analysis; legalSources?: unknown[]; legalAudit?: unknown[]; includedDocumentIds?: string[]; analyzedAt?: string }

const DELIVERY: Record<string, string> = { sent: 'accepted', simulated: 'simulated', failed: 'failed' };

function category(d: StoredDocument): string {
  const t = (d.documentType ?? '').toLowerCase();
  if (/proc[eè]s.?verbal|police report|custody/.test(t)) return 'proces_verbal';
  if (/d[ée]cision|jugement|ordonnance|judgment/.test(t)) return 'decision';
  if (/identit|passport|passeport/.test(t)) return 'identite';
  if (/photo/.test(t)) return 'preuve';
  if (/mail|courrier|lettre|letter|sms|convocation|summons/.test(t)) return 'correspondance';
  return 'autre';
}

function analysesOf(store: MemoryStore, caseId: string) {
  return store.analyses
    .filter((a) => a.caseId === caseId)
    .map((a) => {
      const r = (a.result ?? {}) as Result;
      return {
        id: a.id,
        createdAt: r.analyzedAt ?? new Date(0).toISOString(),
        status: a.status,
        result: r.analysis,
        reviewedDocumentCount: r.includedDocumentIds?.length ?? 0,
        legalSources: r.legalSources ?? [],
        legalAudit: r.legalAudit ?? [],
      };
    })
    .filter((a) => a.result)
    .reverse(); // newest first
}

function escalationOf(store: MemoryStore, caseId: string) {
  const alert = store.outbound.filter((o) => o.caseId === caseId && o.purpose === 'lawyer_alert').at(-1);
  if (!alert) return null;
  const analysis = store.analyses.find((a) => a.id === alert.analysisId) as { result?: Result } | undefined;
  return { status: DELIVERY[alert.status ?? ''] ?? 'pending', updatedAt: analysis?.result?.analyzedAt ?? new Date().toISOString() };
}

function lastActivity(store: MemoryStore, caseId: string): string {
  return store.messages.filter((m) => m.caseId === caseId).at(-1)?.createdAt ?? new Date(0).toISOString();
}

export async function readApiRoutes(app: FastifyInstance, { store }: { store: MemoryStore }) {
  const lawyerName = () => store.people.find((p) => p.role === 'lawyer')?.displayName ?? 'Avocat';
  const name = (id: string) => store.people.find((p) => p.id === id)?.displayName ?? 'Client';

  app.get('/api/cases', async (_req, reply) => {
    const cases = store.cases
      .filter((c) => store.messages.some((m) => m.caseId === c.id)) // hide the empty seeded fixture
      .map((c) => {
        const all = analysesOf(store, c.id);
        const latest = all[0];
        // A case does not become less urgent because a later message is mundane: list it at its highest level.
        const RANK: Urgency[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
        const highest = all.reduce<Urgency>((u, a) => (RANK.indexOf(a.result!.urgency) > RANK.indexOf(u) ? a.result!.urgency : u), 'LOW');
        return {
          id: c.id,
          title: c.title,
          clientName: name(c.clientId),
          status: c.open ? 'open' : 'closed',
          urgency: highest,
          analysisStatus: latest?.status ?? 'ok',
          issue: latest?.result?.issue ?? 'Analyse en cours',
          lastActivityAt: lastActivity(store, c.id),
          documentCount: store.documents.filter((d) => d.caseId === c.id).length,
          escalationStatus: escalationOf(store, c.id)?.status ?? null,
          nextDeadline: null,
          timezone: c.timezone,
        };
      })
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return reply.header('cache-control', 'no-store').send({ lawyerName: lawyerName(), cases });
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id', async (req, reply) => {
    const c = store.cases.find((x) => x.id === req.params.id);
    if (!c) return reply.code(404).send({ error: 'Dossier introuvable' });
    const history = analysesOf(store, c.id);
    const messages = store.messages.filter((m) => m.caseId === c.id);
    const received = (messageId: string) => messages.find((m) => m.id === messageId)?.createdAt ?? new Date().toISOString();
    return reply.header('cache-control', 'no-store').send({
      id: c.id,
      title: c.title,
      status: c.open ? 'open' : 'closed',
      jurisdiction: c.jurisdiction,
      language: c.language,
      timezone: c.timezone,
      clientName: name(c.clientId),
      lawyerName: lawyerName(),
      analysis: history[0] ?? null,
      history,
      escalation: escalationOf(store, c.id),
      deadlines: [],
      documents: store.documents.filter((d) => d.caseId === c.id).map((d) => ({
        id: d.id,
        name: d.documentType ?? 'Document',
        category: category(d),
        mimeType: d.mimeType,
        byteSize: 0,
        status: d.status === 'ready' ? 'ready' : d.status === 'failed' ? 'failed' : 'pending',
        receivedAt: received(d.messageId),
        summary: d.summary ?? null,
        extractedText: d.extractedText,
        dateMentions: [],
        errorReason: d.status === 'failed' ? 'Pièce illisible' : null,
      })),
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        author: m.direction === 'inbound' ? name(c.clientId) : 'Accueil Lexora',
        text: m.text,
        createdAt: m.createdAt,
        documentIds: store.documents.filter((d) => d.messageId === m.id).map((d) => d.id),
      })),
    });
  });
}
