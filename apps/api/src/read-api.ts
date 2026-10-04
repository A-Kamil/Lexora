import type { FastifyInstance } from 'fastify';
import {
  MemoryStore,
  type CaseContext,
  type CaseStore,
  type StoredDocument,
} from '@lexora/shared/pipeline';

/** Read API used by the lawyer dashboard in both PostgreSQL and in-memory modes. */
type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
interface Analysis {
  issue: string;
  urgency: Urgency;
  urgencyReason: string;
  requiresLawyer: boolean;
  missingInformation: string[];
  requestedDocuments: string[];
  recommendedActions: string[];
}
interface Result {
  id?: string;
  analysis?: Analysis;
  status?: 'ok' | 'fallback';
  legalSources?: unknown[];
  legalAudit?: unknown[];
  includedDocumentIds?: string[];
  analyzedAt?: string;
}
interface AnalysisRecord {
  id: string;
  createdAt: string;
  status: 'ok' | 'fallback';
  result: Analysis;
  reviewedDocumentCount: number;
  legalSources: unknown[];
  legalAudit: unknown[];
}

const DELIVERY: Record<string, string> = {
  sent: 'accepted',
  simulated: 'simulated',
  failed: 'failed',
};
const RANK: Urgency[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function contentDisposition(filename: string, mimeType: string): string {
  const disposition = INLINE_MIME_TYPES.has(mimeType) ? 'inline' : 'attachment';
  const asciiFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function category(document: StoredDocument): string {
  const type = (document.documentType ?? '').toLowerCase();
  if (/proc[eè]s.?verbal|police report|custody/.test(type)) return 'proces_verbal';
  if (/d[ée]cision|jugement|ordonnance|judgment/.test(type)) return 'decision';
  if (/identit|passport|passeport/.test(type)) return 'identite';
  if (/photo/.test(type)) return 'preuve';
  if (/mail|courrier|lettre|letter|sms|convocation|summons/.test(type)) {
    return 'correspondance';
  }
  return 'autre';
}

function lastActivity(context: CaseContext): string {
  return context.messages.at(-1)?.createdAt ?? new Date(0).toISOString();
}

async function analysesOf(
  store: CaseStore,
  caseId: string,
  fallbackDate: string,
): Promise<AnalysisRecord[]> {
  if (store instanceof MemoryStore) {
    return store.analyses
      .filter((analysis) => analysis.caseId === caseId)
      .map((analysis) => {
        const result = (analysis.result ?? {}) as Result;
        return result.analysis
          ? {
              id: analysis.id,
              createdAt: result.analyzedAt ?? fallbackDate,
              status: analysis.status,
              result: result.analysis,
              reviewedDocumentCount: result.includedDocumentIds?.length ?? 0,
              legalSources: result.legalSources ?? [],
              legalAudit: result.legalAudit ?? [],
            }
          : null;
      })
      .filter((analysis): analysis is AnalysisRecord => analysis !== null)
      .reverse();
  }

  const latest = (await store.getLatestAnalysis?.(caseId)) as Result | null | undefined;
  if (!latest?.analysis) return [];
  return [
    {
      id: latest.id ?? `latest-${caseId}`,
      createdAt: latest.analyzedAt ?? fallbackDate,
      status: latest.status ?? 'ok',
      result: latest.analysis,
      reviewedDocumentCount: latest.includedDocumentIds?.length ?? 0,
      legalSources: latest.legalSources ?? [],
      legalAudit: latest.legalAudit ?? [],
    },
  ];
}

function escalationOf(store: CaseStore, caseId: string) {
  if (!(store instanceof MemoryStore)) return null;
  const alert = store.outbound
    .filter((outbound) => outbound.caseId === caseId && outbound.purpose === 'lawyer_alert')
    .at(-1);
  if (!alert) return null;
  const analysis = store.analyses.find((item) => item.id === alert.analysisId) as
    | { result?: Result }
    | undefined;
  return {
    status: DELIVERY[alert.status ?? ''] ?? 'pending',
    updatedAt: analysis?.result?.analyzedAt ?? new Date().toISOString(),
  };
}

export async function readApiRoutes(app: FastifyInstance, { store }: { store: CaseStore }) {
  app.get('/api/cases', async (_request, reply) => {
    const contexts = await store.listCaseContexts();
    const summaries = await Promise.all(
      contexts.map(async (context) => {
        const activity = lastActivity(context);
        const analyses = await analysesOf(store, context.case.id, activity);
        const latest = analyses[0];
        const urgency = analyses.reduce<Urgency>(
          (highest, analysis) =>
            RANK.indexOf(analysis.result.urgency) > RANK.indexOf(highest)
              ? analysis.result.urgency
              : highest,
          'LOW',
        );
        return {
          id: context.case.id,
          title: context.case.title,
          clientName: context.client.displayName,
          status: context.case.status ?? 'open',
          urgency,
          analysisStatus: latest?.status ?? 'ok',
          issue: latest?.result.issue ?? 'Analyse en cours',
          lastActivityAt: activity,
          documentCount: context.documents.length,
          escalationStatus: escalationOf(store, context.case.id)?.status ?? null,
          nextDeadline: null,
          timezone: context.case.timezone,
        };
      }),
    );
    summaries.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
    const lawyerName = contexts.find((context) => context.lawyer)?.lawyer?.displayName ?? 'Avocat';
    return reply.header('cache-control', 'no-store').send({ lawyerName, cases: summaries });
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id', async (request, reply) => {
    const context = await store.getCaseContext(request.params.id);
    if (!context) return reply.code(404).send({ error: 'Dossier introuvable' });

    const activity = lastActivity(context);
    const history = await analysesOf(store, context.case.id, activity);
    const received = (messageId: string) =>
      context.messages.find((message) => message.id === messageId)?.createdAt ?? activity;

    return reply.header('cache-control', 'no-store').send({
      id: context.case.id,
      title: context.case.title,
      status: context.case.status ?? 'open',
      jurisdiction: context.case.jurisdiction,
      language: context.case.language,
      timezone: context.case.timezone,
      clientName: context.client.displayName,
      lawyerName: context.lawyer?.displayName ?? 'Avocat',
      analysis: history[0] ?? null,
      history,
      escalation: escalationOf(store, context.case.id),
      deadlines: [],
      documents: context.documents.map((document) => ({
        id: document.id,
        name: document.documentType ?? document.originalFilename ?? 'Document',
        category: category(document),
        mimeType: document.mimeType,
        byteSize: document.byteSize ?? document.originalBytes?.byteLength ?? 0,
        status: document.status,
        receivedAt: received(document.messageId),
        summary: document.summary ?? null,
        extractedText: document.extractedText,
        dateMentions: [],
        errorReason: document.status === 'failed' ? 'Pièce illisible' : null,
      })),
      messages: context.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        author: message.direction === 'inbound' ? context.client.displayName : 'Accueil Lexora',
        text: message.text,
        createdAt: message.createdAt,
        documentIds: context.documents
          .filter((document) => document.messageId === message.id)
          .map((document) => document.id),
      })),
    });
  });

  app.get<{ Params: { caseId: string; documentId: string } }>(
    '/api/cases/:caseId/documents/:documentId/content',
    async (request, reply) => {
      const content = await store.getDocumentContent(
        request.params.caseId,
        request.params.documentId,
      );
      if (!content) return reply.code(404).send({ error: 'Document introuvable' });

      return reply
        .header('cache-control', 'private, no-store')
        .header('content-disposition', contentDisposition(content.filename, content.mimeType))
        .header('content-length', String(content.bytes.byteLength))
        .header('x-content-type-options', 'nosniff')
        .type(content.mimeType)
        .send(Buffer.from(content.bytes));
    },
  );
}
