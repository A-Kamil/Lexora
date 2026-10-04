import type { CaseAnalysis } from '@/types/lexora';

function List({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h3 className="font-serif sub-title">{title}</h3>
      {items.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>{empty}</p>
      ) : (
        <ol className="numbered">
          {items.map((item, i) => (
            <li key={item}>
              <span className="numbered__n tabular">{String(i + 1).padStart(2, '0')}</span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What the lawyer should do next, and what is still missing from the file. */
export function AnalysisPanel({ result }: { result: CaseAnalysis | null }) {
  return (
    <section className="panel" aria-label="Analyse du dossier">
      <p className="section-label">À faire</p>
      {result ? (
        <>
          <List
            title="Actions recommandées"
            items={result.recommendedActions}
            empty="Aucune action recommandée."
          />
          <List
            title="Informations manquantes"
            items={result.missingInformation}
            empty="Aucune information manquante identifiée."
          />
          <List
            title="Documents à demander"
            items={result.requestedDocuments}
            empty="Aucun document à demander."
          />
        </>
      ) : (
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>En attente d’analyse.</p>
      )}
      <p className="disclaimer">
        Évaluation automatisée à vérifier : elle prépare votre travail mais ne constitue ni un avis
        juridique ni une conclusion vérifiée.
      </p>
    </section>
  );
}
