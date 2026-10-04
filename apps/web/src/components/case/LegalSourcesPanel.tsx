import type { LegalLookup, LegalSource } from '@/types/lexora';

const TOOLS: Record<string, string> = { echr: 'Convention EDH', judilibre: 'Judilibre (Cour de cassation)' };
const toolName = (t: string) =>
  TOOLS[t] ?? (t.startsWith('legifrance') ? `Légifrance — ${(t.split(':')[1] ?? 'codes').replace('_', ' ')}` : t);

/** What the system looked up before analysing the case, and the sources it was allowed to cite. */
export function LegalSourcesPanel({ sources, audit }: { sources: LegalSource[]; audit: LegalLookup[] }) {
  return (
    <section className="panel" aria-label="Sources juridiques consultées">
      <p className="section-label">Sources juridiques consultées</p>
      {audit.length === 0 && sources.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>Aucune recherche juridique pour cette analyse.</p>
      ) : (
        <>
          <h3 className="font-serif sub-title">Recherches effectuées</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {audit.map((a, i) => (
              <li key={`${a.tool}-${i}`} style={{ marginBottom: 6 }}>
                {toolName(a.tool)} · {a.ok ? `${a.count} résultat(s)` : 'échec'} · {a.ms} ms
                <br />
                <span style={{ color: 'var(--ink-muted)' }}>
                  Requête : « {a.query} »{a.redacted ? ' (identité masquée)' : ''}
                </span>
              </li>
            ))}
          </ul>
          <h3 className="font-serif sub-title" style={{ marginTop: 18 }}>Sources transmises à l’analyse</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {sources.map((s) => (
              <li key={s.reference} style={{ marginBottom: 6 }}>
                <strong>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer">{s.reference}</a>
                  ) : (
                    s.reference
                  )}
                </strong>
                {s.title ? ` — ${s.title}` : ''}
                {s.excerpt ? (
                  <>
                    <br />
                    <span style={{ color: 'var(--ink-muted)' }}>
                      {s.excerpt.length > 240 ? `${s.excerpt.slice(0, 240)}…` : s.excerpt}
                    </span>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="disclaimer">Sources récupérées automatiquement, à vérifier. Le client ne les voit jamais.</p>
    </section>
  );
}
