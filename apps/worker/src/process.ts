import { readFileSync } from 'node:fs';
import {
  chunkDocument,
  type AnalysisInput,
  type AnalysisResult,
  type ContextDocument,
  type ContextMessage,
  type LegalSource,
} from '@lexora/ai';
import type {
  CaseContext,
  CaseStore,
  InboundMedia,
  RetrievedDocumentChunk,
  StoredMessage,
  Urgency,
} from '@lexora/shared/pipeline';
import type { WorkerConfig } from './config.js';
import {
  jsonLogger,
  maskPhone,
  type AiPort,
  type LegalPort,
  type Logger,
  type MediaDownloader,
  type Messenger,
} from './ports.js';

export interface WorkerDeps {
  store: CaseStore;
  ai: AiPort;
  messenger: Messenger;
  legal: LegalPort;
  clock: () => Date;
  config: WorkerConfig;
  /** Absent: every media download fails (document 'failed', analysis still runs). */
  downloader?: MediaDownloader;
  log?: Logger;
  /** Defaults to apps/worker/urgency-criteria.md. */
  urgencyCriteria?: string;
  /**
   * The CaseStore contract does not expose a message's media yet (see RAPPORT.md, contract requests).
   * Default: a `media` field on the stored message if the store keeps one, otherwise none.
   */
  mediaOf?: (message: StoredMessage) => InboundMedia[] | Promise<InboundMedia[]>;
}

export type ProcessResult =
  | {
      status: 'skipped';
      reason: 'message_not_found' | 'not_inbound' | 'case_not_found' | 'already_analyzed';
      analysisId?: string;
    }
  | {
      status: 'processed';
      analysisId: string;
      urgency: Urgency;
      analysisStatus: 'ok' | 'fallback';
      legalSources: LegalSource[];
      /** null: not urgent, or the lawyer was already alerted at this level. */
      alert: DeliveryStatus | 'no_lawyer' | null;
      /** Intake agent's reply to the client. */
      reply: DeliveryStatus | null;
      /** "A lawyer has been alerted" notice to the client. */
      notice: DeliveryStatus | null;
    };

type DeliveryStatus = 'sent' | 'simulated' | 'failed';

const DOCUMENT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALERT_MAX = 1200;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const RETRIEVAL_CHAR_BUDGET = 12_000;
/** Fallback when the intake agent fails: the client is never left without an answer. */
export const CLIENT_REPLY_RECEIVED =
  "Votre message a bien été reçu. Ceci n'est pas un conseil juridique.";
/** Sent only once the lawyer alert has really left. Bilingual: the sender may write in English. */
export const CLIENT_NOTICE_ALERTED =
  'Un avocat du cabinet a été prévenu et va vous rappeler. / A lawyer from the firm has been alerted and will call you back.';
const RANK = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const repliedByDeps = new WeakMap<WorkerDeps, Set<string>>();

let criteriaCache: string | undefined;
export function defaultUrgencyCriteria(): string {
  criteriaCache ??= readFileSync(new URL('../urgency-criteria.md', import.meta.url), 'utf8');
  return criteriaCache;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Deterministic lawyer alert, no AI in the wording, at most 1 200 characters. */
export function formatLawyerAlert(p: {
  urgency: 'HIGH' | 'CRITICAL';
  clientName: string;
  caseTitle: string;
  issue: string;
  urgencyReason: string;
}): string {
  const text = [
    `LEXORA — ${p.urgency}`,
    `${clip(p.clientName, 120)} — ${clip(p.caseTitle, 160)}`,
    clip(p.issue, 400),
    `Pourquoi : ${clip(p.urgencyReason, 400)}`,
    'À faire : rappeler le client maintenant.',
  ].join('\n');
  return clip(text, ALERT_MAX);
}

function errName(e: unknown) {
  return e instanceof Error ? clip(e.message, 200) : 'error';
}

/** Job `process-inbound {messageId}`: media → intake agent reply ∥ (legal sources → analysis → lawyer alert) → "lawyer alerted" notice. Safe to run twice. */
export async function processInbound(deps: WorkerDeps, messageId: string): Promise<ProcessResult> {
  const log = deps.log ?? jsonLogger;
  const { store } = deps;

  // 1. Message
  const message = await store.getMessage(messageId);
  if (!message) {
    log.warn('message_not_found', { messageId });
    return { status: 'skipped', reason: 'message_not_found' };
  }
  if (message.direction !== 'inbound') {
    log.warn('message_not_inbound', { messageId });
    return { status: 'skipped', reason: 'not_inbound' };
  }

  // 2. Media
  let ctx = await store.getCaseContext(message.caseId);
  if (!ctx) {
    log.warn('case_not_found', { messageId, caseId: message.caseId });
    return { status: 'skipped', reason: 'case_not_found' };
  }
  const media = await (deps.mediaOf ?? defaultMediaOf)(message);
  if (media.length) {
    await processMedia(deps, log, message, media, ctx);
    ctx = (await store.getCaseContext(message.caseId)) ?? ctx;
  }

  // 3. Intake agent: answers the client while the analysis runs (only to the case client, never to the lawyer).
  const current = ctx.messages.find((m) => m.id === message.id) ?? message;
  const retrieved = await retrieveDocumentContext(deps, log, current, ctx);
  const fromClient = Boolean(message.personId && message.personId === ctx.client.id);
  // The agent replies before the analysis is saved (its idempotency gate), so a re-run of the same job must
  // not answer twice. In-process guard: enough while the worker runs inside the API; pg-boss will need a store check.
  const replied = repliedByDeps.get(deps) ?? new Set<string>();
  repliedByDeps.set(deps, replied);
  const firstRun = !replied.has(message.id);
  replied.add(message.id);
  const replyTask: Promise<DeliveryStatus | null> =
    fromClient && firstRun
      ? converseAndReply(deps, log, message, ctx, retrieved)
      : (log.info('client_reply_skipped', { messageId, reason: 'sender is not the case client' }),
        Promise.resolve(null));

  // 4. Context, legal sources, analysis
  const priorMessages = ctx.messages.map((m) => toContextMessage(m, ctx));
  const trigger = toContextMessage(current, ctx);
  if (!trigger.text.trim()) trigger.text = '[message sans texte exploitable : média non lu]';

  let legalSources: LegalSource[] = [];
  try {
    const legal = await deps.legal.gather(trigger.text, {
      clientIdentifiers: [ctx.client.displayName],
    });
    legalSources = legal.sources;
    log.info('legal_context', {
      messageId,
      sources: legal.sources.length,
      lookups: legal.audit.length,
      failed: legal.audit.filter((a) => !a.ok).length,
    });
  } catch (e) {
    log.warn('legal_context_failed', { messageId, error: errName(e) });
  }

  const input: AnalysisInput = {
    caseTitle: ctx.case.title,
    jurisdiction: ctx.case.jurisdiction,
    language: ctx.case.language,
    priorMessages,
    trigger,
    documents: retrieved.analysis,
    legalSources,
    urgencyCriteria: deps.urgencyCriteria ?? defaultUrgencyCriteria(),
  };
  let result: AnalysisResult;
  try {
    result = await deps.ai.analyze(input);
  } catch (e) {
    // An urgent case must not disappear because the provider failed: conservative HIGH, reviewed by a lawyer.
    log.warn('analysis_failed', { messageId, error: errName(e) });
    result = {
      status: 'fallback',
      model: 'none',
      includedMessageIds: [],
      includedDocumentIds: [],
      omitted: { messages: 0, documents: 0, truncatedDocumentIds: [] },
      analysis: {
        issue: 'Analyse automatique indisponible',
        urgency: 'HIGH',
        urgencyReason: "L'analyse automatique a échoué ; revue par un avocat nécessaire.",
        requiresLawyer: true,
        missingInformation: [],
        requestedDocuments: [],
        recommendedActions: ['Revoir le dossier manuellement'],
      },
    };
  }
  const { analysis } = result;

  // 5. Save (idempotent on triggerKey)
  const saved = await store.saveAnalysis({
    caseId: message.caseId,
    conversationId: message.conversationId,
    triggerKey: `message:${message.id}:v1`,
    status: result.status,
    model: result.model,
    result: {
      analysis,
      legalSources,
      includedMessageIds: result.includedMessageIds,
      includedDocumentIds: result.includedDocumentIds,
      omitted: result.omitted,
      analyzedAt: deps.clock().toISOString(),
    },
  });
  if (!saved.created) {
    log.info('analysis_exists', { messageId, analysisId: saved.analysisId });
    await replyTask;
    return { status: 'skipped', reason: 'already_analyzed', analysisId: saved.analysisId };
  }
  log.info('analysis_saved', {
    messageId,
    analysisId: saved.analysisId,
    urgency: analysis.urgency,
    status: result.status,
    legalSources: legalSources.length,
  });

  // 6. Lawyer alert: HIGH/CRITICAL, once per level (the conversation re-analyses every message)
  let alert: DeliveryStatus | 'no_lawyer' | null = null;
  if (analysis.urgency === 'HIGH' || analysis.urgency === 'CRITICAL') {
    const already = store.lastAlertedUrgency
      ? await store.lastAlertedUrgency(message.caseId)
      : null;
    if (already && RANK.indexOf(already) >= RANK.indexOf(analysis.urgency)) {
      log.info('alert_already_sent', {
        messageId,
        caseId: message.caseId,
        urgency: analysis.urgency,
      });
    } else if (!ctx.lawyer) {
      log.warn('no_lawyer', { messageId, caseId: message.caseId, note: 'aucun avocat assigné' });
      alert = 'no_lawyer';
    } else {
      const text = formatLawyerAlert({
        urgency: analysis.urgency,
        clientName: ctx.client.displayName,
        caseTitle: ctx.case.title,
        issue: analysis.issue,
        urgencyReason: analysis.urgencyReason,
      });
      alert = await deliver(deps, log, {
        caseId: message.caseId,
        personId: ctx.lawyer.id,
        phone: ctx.lawyer.phoneE164,
        text,
        purpose: 'lawyer_alert',
        analysisId: saved.analysisId,
      });
    }
  }

  // 7. Tell the client a lawyer was alerted, only when that is true, after the agent's reply.
  const reply = await replyTask;
  let notice: DeliveryStatus | null = null;
  if (fromClient && (alert === 'sent' || alert === 'simulated')) {
    notice = await deliver(deps, log, {
      caseId: message.caseId,
      personId: ctx.client.id,
      phone: ctx.client.phoneE164,
      text: CLIENT_NOTICE_ALERTED,
      purpose: 'client_reply',
      analysisId: saved.analysisId,
    });
  }

  return {
    status: 'processed',
    analysisId: saved.analysisId,
    urgency: analysis.urgency,
    analysisStatus: result.status,
    legalSources,
    alert,
    reply,
    notice,
  };
}

/** Intake agent turn; falls back to a plain acknowledgement so the client always gets an answer. */
async function converseAndReply(
  deps: WorkerDeps,
  log: Logger,
  message: StoredMessage,
  ctx: CaseContext,
  retrieved: RetrievedContext,
): Promise<DeliveryStatus> {
  let text = CLIENT_REPLY_RECEIVED;
  try {
    // The agent runs alongside this message's analysis, so it is steered by the previous one (one turn behind).
    const latest = (
      deps.store.getLatestAnalysis ? await deps.store.getLatestAnalysis(message.caseId) : null
    ) as {
      analysis?: { urgency?: string; missingInformation?: string[]; requestedDocuments?: string[] };
    } | null;
    const a = latest?.analysis;
    const r = await deps.ai.converse({
      caseFile: a?.urgency
        ? {
            urgency: a.urgency,
            missingInformation: a.missingInformation ?? [],
            requestedDocuments: a.requestedDocuments ?? [],
          }
        : null,
      history: ctx.messages.map((m) => toContextMessage(m, ctx)),
      documents: retrieved.conversation,
    });
    if (r.text.trim()) text = r.text.trim();
    log.info('intake_reply', { messageId: message.id, chars: text.length });
  } catch (e) {
    log.warn('intake_reply_failed', { messageId: message.id, error: errName(e) });
  }
  return deliver(deps, log, {
    caseId: message.caseId,
    personId: ctx.client.id,
    phone: ctx.client.phoneE164,
    text,
    purpose: 'client_reply',
  });
}

interface RetrievedContext {
  analysis: ContextDocument[];
  conversation: {
    documentType?: string | null;
    summary?: string | null;
    excerpt?: string | null;
  }[];
}

async function retrieveDocumentContext(
  deps: WorkerDeps,
  log: Logger,
  message: StoredMessage,
  ctx: CaseContext,
): Promise<RetrievedContext> {
  const ready = ctx.documents.filter(
    (document) => document.status === 'ready' && document.extractedText,
  );
  const fallback: RetrievedContext = {
    analysis: ready.map((document) => ({
      id: document.id,
      extractedText: document.extractedText!,
      ...(document.documentType ? { documentType: document.documentType } : {}),
    })),
    conversation: ready.map((document) => ({
      documentType: document.documentType,
      summary: document.summary ?? null,
    })),
  };
  if (!ready.length || !deps.ai.embed || !deps.store.searchDocumentChunks) return fallback;

  try {
    const recent = ctx.messages
      .filter((item) => item.id !== message.id)
      .slice(-5)
      .map((item) => item.text)
      .filter(Boolean);
    const query = [ctx.case.title, ...recent, message.text].filter(Boolean).join('\n');
    const [embedding] = await deps.ai.embed([query]);
    if (!embedding) return fallback;
    const found = await deps.store.searchDocumentChunks({
      caseId: message.caseId,
      conversationId: message.conversationId,
      embedding,
      limit: 6,
    });
    const chunks = withinCharacterBudget(found, RETRIEVAL_CHAR_BUDGET);
    if (!chunks.length) return fallback;

    const grouped = new Map<string, string[]>();
    for (const chunk of chunks) {
      const values = grouped.get(chunk.documentId) ?? [];
      values.push(chunk.content);
      grouped.set(chunk.documentId, values);
    }
    const analysis = [...grouped].map(([documentId, contents]) => {
      const document = ready.find((item) => item.id === documentId);
      return {
        id: documentId,
        extractedText: contents.join('\n\n'),
        ...(document?.documentType ? { documentType: document.documentType } : {}),
      };
    });
    const conversation = analysis.map((document) => ({
      documentType: document.documentType ?? null,
      summary: ready.find((item) => item.id === document.id)?.summary ?? null,
      excerpt: document.extractedText,
    }));
    log.info('document_context_retrieved', {
      messageId: message.id,
      chunks: chunks.length,
      documents: analysis.length,
    });
    return { analysis, conversation };
  } catch (error) {
    log.warn('document_context_failed', { messageId: message.id, error: errName(error) });
    return fallback;
  }
}

function withinCharacterBudget(
  chunks: RetrievedDocumentChunk[],
  budget: number,
): RetrievedDocumentChunk[] {
  const selected: RetrievedDocumentChunk[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used >= budget) break;
    const content = chunk.content.slice(0, budget - used);
    if (!content) break;
    selected.push({ ...chunk, content });
    used += content.length;
  }
  return selected;
}

function defaultMediaOf(message: StoredMessage): InboundMedia[] {
  const media = (message as StoredMessage & { media?: unknown }).media;
  return Array.isArray(media) ? (media as InboundMedia[]) : [];
}

function toContextMessage(m: StoredMessage, ctx: CaseContext): ContextMessage {
  const role =
    m.direction === 'outbound'
      ? 'assistant'
      : m.personId && m.personId === ctx.lawyer?.id
        ? 'lawyer'
        : 'client';
  return { id: m.id, role, text: m.text, at: m.createdAt };
}

async function processMedia(
  deps: WorkerDeps,
  log: Logger,
  message: StoredMessage,
  media: InboundMedia[],
  ctx: CaseContext,
) {
  const { store } = deps;
  const alreadyTranscribed = message.kind === 'voice';
  const alreadyExtracted = ctx.documents.some((d) => d.messageId === message.id);
  const transcripts: string[] = [];

  for (const m of [...media].sort((a, b) => a.index - b.index)) {
    const type = m.contentType.toLowerCase().split(';')[0]!.trim();
    if (type.startsWith('audio/')) {
      if (alreadyTranscribed) continue;
      try {
        if (!deps.downloader) throw new Error('no media downloader configured');
        const file = await deps.downloader.download(m.url);
        const ext = type.split('/')[1] ?? 'ogg';
        const { text } = await deps.ai.transcribe({
          bytes: file.bytes,
          fileName: `voice-${message.id}-${m.index}.${ext}`,
        });
        transcripts.push(text);
        log.info('voice_transcribed', {
          messageId: message.id,
          index: m.index,
          chars: text.length,
        });
      } catch (e) {
        log.warn('voice_failed', { messageId: message.id, index: m.index, error: errName(e) });
      }
    } else if (DOCUMENT_MIME.has(type)) {
      if (alreadyExtracted) continue;
      let originalBytes: Uint8Array | undefined;
      const extension = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg';
      const originalFilename = `document-${message.id}-${m.index}.${extension}`;
      try {
        if (!deps.downloader) throw new Error('no media downloader configured');
        const file = await deps.downloader.download(m.url);
        originalBytes = file.bytes;
        if (originalBytes.byteLength > MAX_DOCUMENT_BYTES)
          throw new Error('document exceeds 10 MB');
        await store.saveDocument({
          caseId: message.caseId,
          messageId: message.id,
          mediaIndex: m.index,
          mimeType: type,
          status: 'pending',
          extractedText: null,
          documentType: null,
          originalBytes,
          originalFilename,
        });
        const r = await deps.ai.extract({
          bytes: originalBytes,
          mimeType: type,
          fileName: originalFilename,
        });
        const d = await store.saveDocument({
          caseId: message.caseId,
          messageId: message.id,
          mediaIndex: m.index,
          mimeType: type,
          status: 'ready',
          extractedText: r.text,
          documentType: r.documentType,
          summary: r.summary ?? null,
          originalBytes,
          originalFilename,
        });
        if (deps.ai.embed && store.replaceDocumentChunks) {
          try {
            const contents = chunkDocument(r.text);
            const embeddings = await deps.ai.embed(contents);
            await store.replaceDocumentChunks(
              d.id,
              contents.map((content, index) => ({ content, embedding: embeddings[index]! })),
              'mistral-embed',
            );
            log.info('document_indexed', {
              messageId: message.id,
              documentId: d.id,
              chunks: contents.length,
            });
          } catch (error) {
            await store.markDocumentEmbeddingFailed?.(d.id, errName(error));
            log.warn('document_index_failed', {
              messageId: message.id,
              documentId: d.id,
              error: errName(error),
            });
          }
        }
        log.info('document_ready', {
          messageId: message.id,
          index: m.index,
          documentId: d.id,
          chars: r.text.length,
        });
      } catch (e) {
        const keepBytes =
          originalBytes && originalBytes.byteLength <= MAX_DOCUMENT_BYTES
            ? originalBytes
            : undefined;
        const d = await store.saveDocument({
          caseId: message.caseId,
          messageId: message.id,
          mediaIndex: m.index,
          mimeType: type,
          status: 'failed',
          extractedText: null,
          documentType: null,
          ...(keepBytes ? { originalBytes: keepBytes, originalFilename } : {}),
        });
        log.warn('document_failed', {
          messageId: message.id,
          index: m.index,
          documentId: d.id,
          error: errName(e),
        });
      }
    } else {
      log.warn('media_unsupported', { messageId: message.id, index: m.index, contentType: type });
    }
  }

  if (transcripts.length) {
    await store.setMessageTranscript(
      message.id,
      [message.text, ...transcripts].filter((t) => t.trim()).join('\n'),
    );
  }
}

async function deliver(
  deps: WorkerDeps,
  log: Logger,
  o: {
    caseId: string;
    personId: string;
    phone: string;
    text: string;
    purpose: 'lawyer_alert' | 'client_reply';
    analysisId?: string;
  },
): Promise<DeliveryStatus> {
  const { store, config } = deps;
  const { messageId } = await store.saveOutbound({
    caseId: o.caseId,
    personId: o.personId,
    text: o.text,
    purpose: o.purpose,
    ...(o.analysisId ? { analysisId: o.analysisId } : {}),
  });
  const fields = { outboundId: messageId, purpose: o.purpose, to: maskPhone(o.phone) };
  // Allowlist guards real sends; fake mode sends nothing, so it is not consulted there. With open intake a
  // client reply is exempt: it only ever goes back to the case client, who wrote to the firm first.
  const exempt = config.openIntake && o.purpose === 'client_reply';
  if (config.messagingMode === 'live' && !exempt && !config.allowedNumbers.includes(o.phone)) {
    await store.markOutbound(messageId, 'failed', undefined, 'numéro non autorisé');
    log.warn('outbound_refused', { ...fields, reason: 'numéro non autorisé' });
    return 'failed';
  }
  try {
    const r = await deps.messenger.send(o.phone, o.text);
    await store.markOutbound(messageId, r.status, r.providerMessageId);
    log.info('outbound_' + r.status, fields);
    return r.status;
  } catch (e) {
    await store.markOutbound(messageId, 'failed', undefined, errName(e));
    log.warn('outbound_failed', { ...fields, error: errName(e) });
    return 'failed';
  }
}
