import { UrgencyTag } from '@/components/UrgencyTag';
import {
  ANALYSIS_STATUS_LABEL,
  ESCALATION,
  URGENCY,
  compactText,
  formatDateTime,
} from '@/lib/legal';
import type { CaseDetail } from '@/types/lexora';

/** Verdict of the case: urgency, why, and whether the alert reached the lawyer. */
export function UrgencyBand({ detail }: { detail: CaseDetail }) {
  const record = detail.analysis;
  if (!record) {
    return (
      <section className="panel" aria-label="Urgence">
        <p className="section-label">Urgence</p>
        <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
          Aucune analyse pour le moment. Elle apparaîtra dès le prochain message du client.
        </p>
      </section>
    );
  }

  const { result } = record;
  const u = URGENCY[result.urgency];
  const escalation = detail.escalation ? ESCALATION[detail.escalation.status] : null;
  const issue = compactText(result.issue, 180);
  const reason = compactText(result.urgencyReason, 120);
  const shortened = issue !== result.issue || reason !== result.urgencyReason;

  return (
    <section
      className="panel"
      aria-label="Urgence"
      style={{ borderLeft: `6px solid ${u.colorVar}`, background: u.colorPaleVar }}
    >
      <div className="urgency-band">
        <div>
          <p className="section-label">Niveau d’urgence</p>
          <div className="urgency-band__level">
            <UrgencyTag urgency={result.urgency} size="ward" showLabel={false} />
            <span className="font-serif" style={{ color: u.colorVar }}>
              {u.label}
            </span>
          </div>
          {result.requiresLawyer ? (
            <p className="urgency-band__flag" style={{ color: u.colorVar }}>
              Intervention de l’avocat requise
            </p>
          ) : null}
        </div>

        <div className="urgency-band__text">
          <p className="urgency-band__issue">{issue}</p>
          <p className="urgency-band__reason">
            <strong>Urgence : </strong>
            {reason}
          </p>
          {shortened ? (
            <details className="urgency-band__details">
              <summary>Voir l’analyse complète</summary>
              <p>{result.issue}</p>
              <p>{result.urgencyReason}</p>
            </details>
          ) : null}
          {record.status === 'fallback' ? (
            <p className="urgency-band__flag" style={{ color: 'var(--critical)' }}>
              ◆ {ANALYSIS_STATUS_LABEL.fallback}
            </p>
          ) : null}
        </div>

        <dl className="urgency-band__facts">
          <div>
            <dt>Analyse</dt>
            <dd>{formatDateTime(record.createdAt, detail.timezone)}</dd>
          </div>
          <div>
            <dt>Documents lus</dt>
            <dd className="tabular">
              {record.reviewedDocumentCount} sur {detail.documents.length}
            </dd>
          </div>
          {escalation ? (
            <div>
              <dt>Alerte à l’avocat</dt>
              <dd
                style={
                  escalation.attention ? { color: 'var(--critical)', fontWeight: 600 } : undefined
                }
              >
                {escalation.attention ? '▲ ' : ''}
                {escalation.label}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
    </section>
  );
}
