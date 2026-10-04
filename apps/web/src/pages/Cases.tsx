/**
 * Cases — `/dossiers`
 * Every open case, most urgent first, refreshed every 10 seconds.
 */

import { Link } from 'react-router-dom';
import { UrgencyTag } from '@/components/UrgencyTag';
import { TopBar } from '@/components/TopBar';
import { ESCALATION, URGENCY, formatCountdown, formatDateTime, formatRelative } from '@/lib/legal';
import { useCases } from '@/state/useCases';
import type { CaseSummary } from '@/types/lexora';

function sortCases(cases: CaseSummary[]): CaseSummary[] {
  return [...cases].sort(
    (a, b) =>
      URGENCY[b.urgency].rank - URGENCY[a.urgency].rank ||
      b.lastActivityAt.localeCompare(a.lastActivityAt),
  );
}

function CaseRow({ c }: { c: CaseSummary }) {
  const u = URGENCY[c.urgency];
  const escalation = c.escalationStatus ? ESCALATION[c.escalationStatus] : null;
  return (
    <li>
      <Link
        to={`/dossiers/${c.id}`}
        className="case-row"
        style={{ borderLeft: `6px solid ${u.colorVar}` }}
      >
        <div className="case-row__urgency">
          <UrgencyTag urgency={c.urgency} size="medium" />
        </div>
        <div className="case-row__main">
          <div className="case-row__client font-serif">{c.clientName}</div>
          <div className="case-row__title">{c.title}</div>
          <p className="case-row__issue">{c.issue}</p>
          {c.analysisStatus === 'fallback' ? (
            <p className="case-row__flag">◆ Analyse automatique indisponible — à examiner</p>
          ) : null}
          {escalation?.attention ? <p className="case-row__flag">▲ {escalation.label}</p> : null}
        </div>
        <dl className="case-row__meta">
          <div>
            <dt>Dernier échange</dt>
            <dd>{formatRelative(c.lastActivityAt)}</dd>
          </div>
          <div>
            <dt>Documents</dt>
            <dd className="tabular">{c.documentCount}</dd>
          </div>
          <div>
            <dt>Prochaine échéance</dt>
            <dd>
              {c.nextDeadline ? (
                <>
                  {formatDateTime(c.nextDeadline.dueAt, c.timezone)}
                  <br />
                  <span style={{ color: 'var(--ink-soft)' }}>
                    {formatCountdown(c.nextDeadline.dueAt)}
                  </span>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>
      </Link>
    </li>
  );
}

export function CasesPage() {
  const { data, error, updatedAt } = useCases();
  const cases = data ? sortCases(data.cases.filter((c) => c.status === 'open')) : [];
  const urgentCount = cases.filter((c) => c.urgency === 'HIGH' || c.urgency === 'CRITICAL').length;

  return (
    <>
      <TopBar />
      <main className="page-body">
        <div className="page-heading">
          <h1 className="font-serif">Mes dossiers</h1>
          <p className="page-heading__sub">
            {data
              ? `${cases.length} dossier${cases.length > 1 ? 's' : ''} ouvert${cases.length > 1 ? 's' : ''} · ${urgentCount} urgent${urgentCount > 1 ? 's' : ''}`
              : 'Chargement…'}
            {updatedAt ? (
              <span style={{ color: 'var(--ink-muted)' }}>
                {' '}
                · actualisé à {new Date(updatedAt).toLocaleTimeString('fr-FR', { hour12: false })}
              </span>
            ) : null}
          </p>
        </div>

        {error && !data ? (
          <p role="alert" style={{ color: 'var(--critical)' }}>
            Impossible de charger les dossiers. Nouvelle tentative dans quelques secondes.
          </p>
        ) : null}

        {data && cases.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)' }}>Aucun dossier ouvert pour le moment.</p>
        ) : null}

        <ul className="case-list">
          {cases.map((c) => (
            <CaseRow key={c.id} c={c} />
          ))}
        </ul>
      </main>
    </>
  );
}
