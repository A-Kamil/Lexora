import { readFileSync } from 'node:fs';
import type { AnalysisInput, AnalysisResult, ContextMessage, LegalSource } from '@lexora/ai';
import type { CaseContext, CaseStore, InboundMedia, StoredMessage, Urgency } from '@lexora/shared';
import type { WorkerConfig } from './config.js';
import { jsonLogger, maskPhone, type AiPort, type LegalPort, type Logger, type MediaDownloader, type Messenger } from './ports.js';

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
  | { status: 'skipped'; reason: 'message_not_found' | 'not_inbound' | 'case_not_found' | 'already_analyzed'; analysisId?: string }
  | {
      status: 'processed';
      analysisId: string;
      urgency: Urgency;
      analysisStatus: 'ok' | 'fallback';
      legalSources: LegalSource[];
      alert: DeliveryStatus | 'no_lawyer' | null;
      reply: DeliveryStatus | null;
    };

type DeliveryStatus = 'sent' | 'simulated' | 'failed';

const DOCUMENT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALERT_MAX = 1200;
export const CLIENT_REPLY_ALERTED = 'Votre message a bien été reçu. Un avocat du cabinet a été prévenu. Ceci n\'est pas un conseil juridique.';
export const CLIENT_REPLY_RECEIVED = 'Votre message a bien été reçu. Ceci n\'est pas un conseil juridique.';

let criteriaCache: string | undefined;
export function defaultUrgencyCriteria(): string {
  criteriaCache ??= readFileSync(new URL('../urgency-criteria.md', import.meta.url), 'utf8');
  return criteriaCache;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Deterministic lawyer alert, no AI in the wording, at most 1 200 characters. */
export function formatLawyerAlert(p: { urgency: 'HIGH' | 'CRITICAL'; clientName: string; caseTitle: string; issue: string; urgencyReason: string }): string {
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

/** Job `process-inbound {messageId}`: media → context → analysis → lawyer alert → client acknowledgement. Safe to run twice. */
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

  // 3. Context, legal sources, analysis
  const current = ctx.messages.find((m) => m.id === message.id) ?? message;
  const priorMessages = ctx.messages.map((m) => toContextMessage(m, ctx));
  const trigger = toContextMessage(current, ctx);
  if (!trigger.text.trim()) trigger.text = '[message sans texte exploitable : média non lu]';

  let legalSources: LegalSource[] = [];
  try {
    const legal = await deps.legal.gather(trigger.text, { clientIdentifiers: [ctx.client.displayName] });
    legalSources = legal.sources;
    log.info('legal_context', { messageId, sources: legal.sources.length, lookups: legal.audit.length, failed: legal.audit.filter((a) => !a.ok).length });
  } catch (e) {
    log.warn('legal_context_failed', { messageId, error: errName(e) });
  }

  const input: AnalysisInput = {
    caseTitle: ctx.case.title,
    jurisdiction: ctx.case.jurisdiction,
    language: ctx.case.language,
    priorMessages,
    trigger,
    documents: ctx.documents
      .filter((d) => d.status === 'ready' && d.extractedText)
      .map((d) => ({ id: d.id, extractedText: d.extractedText!, ...(d.documentType ? { documentType: d.documentType } : {}) })),
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
      status: 'fallback', model: 'none', includedMessageIds: [], includedDocumentIds: [], omitted: { messages: 0, documents: 0, truncatedDocumentIds: [] },
      analysis: { issue: 'Analyse automatique indisponible', urgency: 'HIGH', urgencyReason: 'L\'analyse automatique a échoué ; revue par un avocat nécessaire.', requiresLawyer: true, missingInformation: [], requestedDocuments: [], recommendedActions: ['Revoir le dossier manuellement'] },
    };
  }
  const { analysis } = result;

  // 4. Save (idempotent on triggerKey)
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
    return { status: 'skipped', reason: 'already_analyzed', analysisId: saved.analysisId };
  }
  log.info('analysis_saved', { messageId, analysisId: saved.analysisId, urgency: analysis.urgency, status: result.status, legalSources: legalSources.length });

  // 5. Lawyer alert
  let alert: DeliveryStatus | 'no_lawyer' | null = null;
  if (analysis.urgency === 'HIGH' || analysis.urgency === 'CRITICAL') {
    if (!ctx.lawyer) {
      log.warn('no_lawyer', { messageId, caseId: message.caseId, note: 'aucun avocat assigné' });
      alert = 'no_lawyer';
    } else {
      const text = formatLawyerAlert({ urgency: analysis.urgency, clientName: ctx.client.displayName, caseTitle: ctx.case.title, issue: analysis.issue, urgencyReason: analysis.urgencyReason });
      alert = await deliver(deps, log, { caseId: message.caseId, personId: ctx.lawyer.id, phone: ctx.lawyer.phoneE164, text, purpose: 'lawyer_alert', analysisId: saved.analysisId });
    }
  }

  // 6. Client acknowledgement (only to the client; says a lawyer was told only when that is true)
  let reply: DeliveryStatus | null = null;
  if (message.personId && message.personId === ctx.client.id) {
    const alerted = alert === 'sent' || alert === 'simulated';
    reply = await deliver(deps, log, { caseId: message.caseId, personId: ctx.client.id, phone: ctx.client.phoneE164, text: alerted ? CLIENT_REPLY_ALERTED : CLIENT_REPLY_RECEIVED, purpose: 'client_reply', analysisId: saved.analysisId });
  } else {
    log.info('client_reply_skipped', { messageId, reason: 'sender is not the case client' });
  }

  return { status: 'processed', analysisId: saved.analysisId, urgency: analysis.urgency, analysisStatus: result.status, legalSources, alert, reply };
}

function defaultMediaOf(message: StoredMessage): InboundMedia[] {
  const media = (message as StoredMessage & { media?: unknown }).media;
  return Array.isArray(media) ? (media as InboundMedia[]) : [];
}

function toContextMessage(m: StoredMessage, ctx: CaseContext): ContextMessage {
  const role = m.direction === 'outbound' ? 'assistant' : m.personId && m.personId === ctx.lawyer?.id ? 'lawyer' : 'client';
  return { id: m.id, role, text: m.text, at: m.createdAt };
}

async function processMedia(deps: WorkerDeps, log: Logger, message: StoredMessage, media: InboundMedia[], ctx: CaseContext) {
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
        const { text } = await deps.ai.transcribe({ bytes: file.bytes, fileName: `voice-${message.id}-${m.index}.${ext}` });
        transcripts.push(text);
        log.info('voice_transcribed', { messageId: message.id, index: m.index, chars: text.length });
      } catch (e) {
        log.warn('voice_failed', { messageId: message.id, index: m.index, error: errName(e) });
      }
    } else if (DOCUMENT_MIME.has(type)) {
      if (alreadyExtracted) continue;
      try {
        if (!deps.downloader) throw new Error('no media downloader configured');
        const file = await deps.downloader.download(m.url);
        const r = await deps.ai.extract({ bytes: file.bytes, mimeType: type, fileName: `document-${message.id}-${m.index}` });
        const d = await store.saveDocument({ caseId: message.caseId, messageId: message.id, mimeType: type, status: 'ready', extractedText: r.text, documentType: r.documentType, summary: r.summary ?? null });
        log.info('document_ready', { messageId: message.id, index: m.index, documentId: d.id, chars: r.text.length });
      } catch (e) {
        const d = await store.saveDocument({ caseId: message.caseId, messageId: message.id, mimeType: type, status: 'failed', extractedText: null, documentType: null });
        log.warn('document_failed', { messageId: message.id, index: m.index, documentId: d.id, error: errName(e) });
      }
    } else {
      log.warn('media_unsupported', { messageId: message.id, index: m.index, contentType: type });
    }
  }

  if (transcripts.length) {
    await store.setMessageTranscript(message.id, [message.text, ...transcripts].filter((t) => t.trim()).join('\n'));
  }
}

async function deliver(
  deps: WorkerDeps,
  log: Logger,
  o: { caseId: string; personId: string; phone: string; text: string; purpose: 'lawyer_alert' | 'client_reply'; analysisId: string },
): Promise<DeliveryStatus> {
  const { store, config } = deps;
  const { messageId } = await store.saveOutbound({ caseId: o.caseId, personId: o.personId, text: o.text, purpose: o.purpose, analysisId: o.analysisId });
  const fields = { outboundId: messageId, purpose: o.purpose, to: maskPhone(o.phone) };
  // Allowlist guards real sends; fake mode sends nothing, so it is not consulted there.
  if (config.messagingMode === 'live' && !config.allowedNumbers.includes(o.phone)) {
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
