import type { Piste } from './piste.js';
import type { LegalSource } from '../analyze.js';

const BASE = '/dila/legifrance/lf-engine-app';
export const CODES = {
  travail: { id: 'LEGITEXT000006072050', name: 'Code du travail' },
  civil: { id: 'LEGITEXT000006070721', name: 'Code civil' },
  securite_sociale: { id: 'LEGITEXT000006073189', name: 'Code de la sécurité sociale' },
  penal: { id: 'LEGITEXT000006070719', name: 'Code pénal' },
  procedure_penale: { id: 'LEGITEXT000006071154', name: 'Code de procédure pénale' },
} as const;
export type CodeKey = keyof typeof CODES;

const clean = (html: string | undefined) => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const url = (id: string) => `https://www.legifrance.gouv.fr/codes/article_lc/${id}`;

/** Article in force, e.g. getArticle(piste, 'travail', 'L1232-1'). */
export async function getArticle(piste: Piste, code: CodeKey, num: string): Promise<LegalSource> {
  const j = await piste.post<{ article?: { id?: string; num?: string; texteHtml?: string; texte?: string } }>(
    `${BASE}/consult/getArticleWithIdAndNum`, { id: CODES[code].id, num });
  const a = j.article ?? {};
  return { reference: `${CODES[code].name}, art. ${a.num ?? num}`, title: `Article ${a.num ?? num}`, excerpt: clean(a.texteHtml ?? a.texte).slice(0, 4000), url: a.id ? url(a.id) : null };
}

interface SearchResponse { results?: Array<{ sections?: Array<{ extracts?: Array<{ id?: string; num?: string; values?: string[] }> }> }> }

/** Full-text search in one code, version in force today. */
const STOP = new Set(["d'un", "d'une", "l'", 'des', 'les', 'une', 'pour', 'par', 'sur', 'dans', 'que', 'qui', 'aux', 'est', 'droit', 'du', 'de', 'la', 'le', 'un', 'et', 'à', 'au']);
const keywords = (q: string) => q.toLowerCase().replace(/[’']/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).join(' ');

/** Full-text search in one code, version in force today. All keywords first (precise), any keyword as fallback. */
export async function searchCode(piste: Piste, query: string, code: CodeKey = 'travail', n = 5): Promise<LegalSource[]> {
  const kw = keywords(query) || query;
  let precise: LegalSource[] = [];
  try {
    precise = await searchCodeWith(piste, kw, code, n, 'TOUS_LES_MOTS_DANS_UN_CHAMP');
  } catch {
    // precise mode refused by the API: fall back to the mode verified live
  }
  return precise.length ? precise : searchCodeWith(piste, kw, code, n, 'UN_DES_MOTS');
}

async function searchCodeWith(piste: Piste, query: string, code: CodeKey, n: number, typeRecherche: string): Promise<LegalSource[]> {
  const j = await piste.post<SearchResponse>(`${BASE}/search`, {
    fond: 'CODE_DATE',
    recherche: {
      champs: [{ typeChamp: 'ALL', operateur: 'ET', criteres: [{ typeRecherche, valeur: query, operateur: 'ET' }] }],
      filtres: [{ facette: 'DATE_VERSION', singleDate: Date.now() }, { facette: 'NOM_CODE', valeurs: [CODES[code].name] }],
      pageNumber: 1, pageSize: n, operateur: 'ET', sort: 'PERTINENCE', typePagination: 'ARTICLE',
    },
  });
  const out: LegalSource[] = [];
  for (const r of j.results ?? []) for (const s of r.sections ?? []) for (const e of s.extracts ?? []) {
    if (e.id?.startsWith('LEGIARTI')) out.push({ reference: `${CODES[code].name}, art. ${e.num ?? e.id}`, title: `Article ${e.num ?? ''}`.trim(), excerpt: clean((e.values ?? []).join(' ')).slice(0, 500), url: url(e.id) });
  }
  return out.slice(0, n);
}
