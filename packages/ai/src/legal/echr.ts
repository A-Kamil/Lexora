import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LegalSource } from '../analyze.js';

/**
 * European Convention on Human Rights + Protocols, official French text supplied by the team's lawyer
 * (Cour européenne des droits de l'homme). Parsed article by article into data/cedh.json. Local search only.
 */
interface Article { instrument: string; num: number; titre: string; texte: string }
let cache: Article[] | null = null;
function articles(): Article[] {
  if (!cache) {
    const path = fileURLToPath(new URL('../../data/cedh.json', import.meta.url));
    cache = (JSON.parse(readFileSync(path, 'utf8')) as { articles: Article[] }).articles;
  }
  return cache;
}

const STOP = new Set('les des une pour par sur dans que qui pas est son ses sont cette tout toute toutes aux'.split(' '));
const words = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [];
const ref = (a: Article) => (a.instrument === 'Convention' ? `CEDH art. ${a.num}` : `${a.instrument} à la CEDH, art. ${a.num}`);

export function searchEchr(question: string, n = 4): LegalSource[] {
  const q = new Set(words(question));
  return articles()
    .map((a) => {
      const body = words(a.texte);
      const score = 3 * words(a.titre).filter((w) => q.has(w)).length + body.filter((w) => q.has(w)).length / (1 + body.length / 200);
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, n)
    .map(({ a }) => ({ reference: ref(a), title: a.titre, excerpt: a.texte.slice(0, 600), url: 'https://www.echr.coe.int/documents/d/echr/Convention_FRA' }));
}

export function getEchrArticle(num: number, instrument = 'Convention'): LegalSource | null {
  const a = articles().find((x) => x.num === num && x.instrument.toLowerCase() === instrument.toLowerCase());
  return a ? { reference: ref(a), title: a.titre, excerpt: a.texte.slice(0, 4000), url: null } : null;
}
