import type { Piste } from './piste.js';
import type { LegalSource } from '../analyze.js';

interface JudilibreResponse { results?: Array<{ id?: string; chamber?: string; decision_date?: string; number?: string; solution?: string; summary?: string; highlights?: { text?: string[] } }> }

/** Cour de cassation decisions (Judilibre open data). */
export async function searchCaseLaw(piste: Piste, query: string, n = 5): Promise<LegalSource[]> {
  const j = await piste.get<JudilibreResponse>('/cassation/judilibre/v1.0/search', { query, page_size: String(n) });
  return (j.results ?? []).slice(0, n).map((r) => ({
    reference: `Cass. ${r.chamber ?? ''} ${r.decision_date ?? ''} n° ${r.number ?? ''}`.replace(/\s+/g, ' ').trim(),
    title: r.solution ?? 'Décision',
    excerpt: (r.summary ?? (r.highlights?.text ?? []).slice(0, 2).join(' ')).slice(0, 600),
    url: r.id ? `https://www.courdecassation.fr/decision/${r.id}` : null,
  }));
}
