import type { LegalSource } from './analyze.js';
import { Piste, type PisteConfig } from './legal/piste.js';
import { getArticle, searchCode, type CodeKey } from './legal/legifrance.js';
import { searchCaseLaw } from './legal/judilibre.js';
import { findCompany } from './legal/companies.js';
import { getEchrArticle, searchEchr } from './legal/echr.js';
import { redactForExternal } from './legal/redact.js';

export type LegalContextMode = 'disabled' | 'mock' | 'direct';

/** One audit line per external lookup: what was asked (after redaction), outcome, duration. */
export interface LegalAuditEntry { tool: string; query: string; redacted: boolean; ok: boolean; count: number; ms: number }

export interface LegalContextOptions {
  mode: LegalContextMode;
  piste?: PisteConfig;
  clientIdentifiers?: string[];
  codes?: CodeKey[];
}

const MOCK: LegalSource[] = [{ reference: 'MOCK', title: 'Mock legal source', excerpt: 'Fixture used without credentials.', url: null }];

/**
 * Gathers sources for a legal question: codes in force (Légifrance), case law (Judilibre), ECHR (local).
 * An unavailable source never breaks the pipeline: it yields an audit entry with ok=false.
 */
export async function gatherLegalContext(question: string, opts: LegalContextOptions): Promise<{ sources: LegalSource[]; audit: LegalAuditEntry[] }> {
  if (opts.mode === 'disabled') return { sources: [], audit: [] };
  if (opts.mode === 'mock') return { sources: MOCK, audit: [] };
  const { text: q, redacted } = redactForExternal(question, opts.clientIdentifiers ?? []);
  const audit: LegalAuditEntry[] = [];
  const run = async (tool: string, fn: () => Promise<LegalSource[]> | LegalSource[]) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      audit.push({ tool, query: q, redacted, ok: true, count: r.length, ms: Date.now() - t0 });
      return r;
    } catch {
      audit.push({ tool, query: q, redacted, ok: false, count: 0, ms: Date.now() - t0 });
      return [];
    }
  };
  const piste = opts.piste ? new Piste(opts.piste) : null;
  const batches = await Promise.all([
    ...(piste ? (opts.codes ?? ['travail']).map((c) => run(`legifrance:${c}`, () => searchCode(piste, q, c, 4))) : []),
    piste ? run('judilibre', () => searchCaseLaw(piste, q, 3)) : Promise.resolve([]),
    run('echr', () => searchEchr(q, 3)),
  ]);
  return { sources: batches.flat(), audit };
}

/** Tool definitions for a Mistral function-calling agent (e.g. the voice/WhatsApp intake agent). */
export const legalTools = [
  { type: 'function' as const, function: { name: 'search_code', description: 'Full-text search in a French code in force (Légifrance). Never include the client name.', parameters: { type: 'object', properties: { query: { type: 'string' }, code: { type: 'string', enum: ['travail', 'civil', 'securite_sociale', 'penal', 'procedure_penale'] } }, required: ['query'] } } },
  { type: 'function' as const, function: { name: 'get_article', description: 'Official text in force of one article, e.g. code=travail num=L1232-1.', parameters: { type: 'object', properties: { code: { type: 'string', enum: ['travail', 'civil', 'securite_sociale', 'penal', 'procedure_penale'] }, num: { type: 'string' } }, required: ['code', 'num'] } } },
  { type: 'function' as const, function: { name: 'search_case_law', description: 'Cour de cassation decisions (Judilibre).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function' as const, function: { name: 'search_echr', description: 'European Convention on Human Rights and protocols (official FR text).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function' as const, function: { name: 'find_company', description: 'Identify an employer / opposing party in the official company registry.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
];

/** Executes one tool call from the model, with client-identity redaction on every external query. */
export async function runLegalTool(name: string, rawArgs: string, opts: LegalContextOptions): Promise<{ result: unknown; audit: LegalAuditEntry }> {
  let args: Record<string, string>;
  try { args = JSON.parse(rawArgs || '{}'); } catch { args = JSON.parse(rawArgs.slice(0, rawArgs.indexOf('}') + 1) || '{}'); } // tolerate glued JSON objects
  const ids = opts.clientIdentifiers ?? [];
  const q = redactForExternal(args.query ?? args.name ?? args.num ?? '', name === 'find_company' ? [] : ids);
  const t0 = Date.now();
  const piste = opts.piste ? new Piste(opts.piste) : null;
  try {
    let result: unknown;
    if (name === 'search_echr') result = searchEchr(q.text);
    else if (name === 'find_company') result = await findCompany(q.text);
    else if (!piste) throw new Error('PISTE not configured');
    else if (name === 'search_code') result = await searchCode(piste, q.text, (args.code as CodeKey) ?? 'travail');
    else if (name === 'get_article') result = await getArticle(piste, args.code as CodeKey, args.num ?? '');
    else if (name === 'search_case_law') result = await searchCaseLaw(piste, q.text);
    else throw new Error(`unknown tool ${name}`);
    const count = Array.isArray(result) ? result.length : result ? 1 : 0;
    return { result, audit: { tool: name, query: q.text, redacted: q.redacted, ok: true, count, ms: Date.now() - t0 } };
  } catch (e) {
    return { result: { error: `source unavailable (${e instanceof Error ? e.message : 'error'})` }, audit: { tool: name, query: q.text, redacted: q.redacted, ok: false, count: 0, ms: Date.now() - t0 } };
  }
}

export { getEchrArticle };
