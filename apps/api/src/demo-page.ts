import type { FastifyInstance } from 'fastify';
import { MemoryStore, type CaseContext } from '@lexora/shared/pipeline';
import { z } from 'zod';

const REFRESH_SECONDS = 3;
const EXTRACT_CHARS = 400;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// `result` is `unknown` in the contract: read what we can, ignore the rest.
const analysisSchema = z.object({
  urgency: z.string().optional(),
  urgencyReason: z.string().optional(),
  missingInformation: z.array(z.string()).optional(),
  recommendedActions: z.array(z.string()).optional(),
});

function readAnalysis(result: unknown): z.infer<typeof analysisSchema> {
  const direct = analysisSchema.safeParse(result);
  if (direct.success && direct.data.urgency) return direct.data;
  const nested = z.object({ analysis: analysisSchema }).safeParse(result);
  if (nested.success) return nested.data.analysis;
  return direct.success ? direct.data : {};
}

export interface DemoOutbound { recipient: string; purpose: string; text: string; status: string; error?: string }
export interface DemoAnalysis { status: string; model: string; result: unknown }
export interface DemoView { context: CaseContext | null; analysis: DemoAnalysis | null; outbound: DemoOutbound[]; now: Date }

function time(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('fr-FR', { timeZone, dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return d.toISOString();
  }
}

function list(items: string[] | undefined, empty: string): string {
  if (!items || items.length === 0) return `<p class="muted">${escapeHtml(empty)}</p>`;
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

const PURPOSES: Record<string, string> = { lawyer_alert: 'Alerte à l’avocat', client_reply: 'Accusé au client' };
const KINDS: Record<string, string> = { voice: 'Message vocal (transcription)', document: 'Document', text: 'Texte', system: 'Système' };
const STATUSES: Record<string, string> = { sent: 'envoyé', failed: 'échec', simulated: 'simulé', pending: 'en attente' };

export function renderDemoPage({ context, analysis, outbound, now }: DemoView): string {
  let body: string;
  if (!context) {
    body = '<p class="muted">Aucun dossier en mémoire.</p>';
  } else {
    const tz = context.case.timezone;
    const inbound = context.messages.filter((m) => m.direction === 'inbound');
    const messages = inbound.length === 0
      ? '<p class="muted">Aucun message reçu.</p>'
      : inbound.map((m) => `<article><div class="meta">${escapeHtml(time(m.createdAt, tz))} · ${escapeHtml(KINDS[m.kind] ?? m.kind)}</div><p>${escapeHtml(m.text) || '<span class="muted">(sans texte)</span>'}</p></article>`).join('');

    const documents = context.documents.length === 0
      ? '<p class="muted">Aucun document.</p>'
      : context.documents.map((d) => {
          const extract = d.summary ? d.summary : d.extractedText ? d.extractedText.slice(0, EXTRACT_CHARS) + (d.extractedText.length > EXTRACT_CHARS ? '…' : '') : '';
          return `<article><div class="meta">${escapeHtml(d.documentType ?? 'type inconnu')} · ${escapeHtml(d.mimeType)} · ${escapeHtml(d.status)}</div>${extract ? `<p>${escapeHtml(extract)}</p>` : '<p class="muted">Pas encore de texte.</p>'}</article>`;
        }).join('');

    let analysisHtml = '<p class="muted">Pas encore d’analyse.</p>';
    if (analysis) {
      const a = readAnalysis(analysis.result);
      const urgency = a.urgency ?? '?';
      const level = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(urgency) ? urgency.toLowerCase() : 'unknown';
      analysisHtml = `<div class="urgency ${level}">${escapeHtml(urgency)}</div>
<p class="meta">${analysis.status === 'fallback' ? 'Analyse de secours — vérification humaine requise · ' : ''}${escapeHtml(analysis.model)}</p>
<h3>Raison</h3><p>${escapeHtml(a.urgencyReason ?? '')}</p>
<h3>Informations manquantes</h3>${list(a.missingInformation, 'Aucune.')}
<h3>Actions recommandées</h3>${list(a.recommendedActions, 'Aucune.')}`;
    }

    const sent = outbound.length === 0
      ? '<p class="muted">Aucun message envoyé.</p>'
      : outbound.map((o) => `<article><div class="meta">${escapeHtml(PURPOSES[o.purpose] ?? o.purpose)} → ${escapeHtml(o.recipient)} · <span class="status ${escapeHtml(o.status)}">${escapeHtml(STATUSES[o.status] ?? o.status)}</span>${o.error ? ` · ${escapeHtml(o.error)}` : ''}</div><p>${escapeHtml(o.text)}</p></article>`).join('');

    body = `<header><h1>${escapeHtml(context.case.title)}</h1><p class="meta">Client : ${escapeHtml(context.client.displayName)} · Avocat : ${escapeHtml(context.lawyer?.displayName ?? 'aucun')}</p></header>
<main>
<section class="analysis"><h2>Dernière analyse</h2>${analysisHtml}</section>
<section><h2>Messages reçus</h2>${messages}</section>
<section><h2>Documents</h2>${documents}</section>
<section><h2>Messages envoyés</h2>${sent}</section>
</main>`;
  }

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Lexora — démo</title>
<style>
body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px;background:#f6f6f4;color:#1b1b1b}
h1{margin:0 0 4px;font-size:1.6rem}h2{font-size:1.1rem;margin:0 0 8px}h3{font-size:.95rem;margin:12px 0 4px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:16px}
section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px}
section.analysis{grid-column:1/-1}
article{border-top:1px solid #eee;padding:8px 0}article:first-of-type{border-top:0}
article p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.meta{color:#666;font-size:.85rem}.muted{color:#888}
.urgency{display:inline-block;font-size:3rem;font-weight:800;letter-spacing:.05em;padding:4px 20px;border-radius:8px;color:#fff;background:#777}
.urgency.critical{background:#b00020}.urgency.high{background:#d9480f}.urgency.medium{background:#b08900}.urgency.low{background:#2b8a3e}
.status.failed{color:#b00020;font-weight:600}.status.sent{color:#2b8a3e;font-weight:600}
footer{margin-top:16px;color:#888;font-size:.8rem}
</style>
</head>
<body>
${body}
<footer>Lecture seule · rafraîchi toutes les ${REFRESH_SECONDS} s · ${escapeHtml(now.toISOString())}</footer>
</body>
</html>`;
}

/** Read-only demo screen over the in-memory store (analyses and outbound are not readable through CaseStore). */
export async function demoRoutes(app: FastifyInstance, { store }: { store: MemoryStore }) {
  app.get('/demo', async (_request, reply) => {
    // The case that received the latest inbound message: the one the jury just wrote to.
    const latest = store.messages.filter((m) => m.direction === 'inbound').at(-1);
    const c = store.cases.find((x) => x.id === latest?.caseId) ?? store.cases.find((x) => x.open) ?? store.cases[0];
    const context = c ? await store.getCaseContext(c.id) : null;
    const last = c ? store.analyses.filter((a) => a.caseId === c.id).at(-1) : undefined;
    const outbound = c
      ? store.outbound.filter((o) => o.caseId === c.id).map((o) => ({
          recipient: store.people.find((p) => p.id === o.personId)?.displayName ?? 'inconnu',
          purpose: o.purpose, text: o.text, status: o.status ?? 'pending', ...(o.error ? { error: o.error } : {}),
        }))
      : [];
    const html = renderDemoPage({
      context,
      analysis: last ? { status: last.status, model: last.model, result: last.result } : null,
      outbound,
      now: new Date(),
    });
    return reply
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(html);
  });
}
