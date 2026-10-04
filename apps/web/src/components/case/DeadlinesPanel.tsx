import { formatCountdown, formatDateTime } from '@/lib/legal';
import type { Deadline } from '@/types/lexora';

export function DeadlinesPanel({
  deadlines,
  timezone,
}: {
  deadlines: Deadline[];
  timezone: string;
}) {
  const sorted = [...deadlines].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  return (
    <section className="panel" aria-label="Échéances">
      <p className="section-label">Échéances</p>
      {sorted.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>Aucune échéance connue.</p>
      ) : (
        <ul className="plain-list">
          {sorted.map((d) => {
            const confirmed = d.verification === 'confirmed';
            return (
              <li key={d.id} className="deadline">
                <div className="deadline__title">{d.title}</div>
                <div className="tabular">{formatDateTime(d.dueAt, timezone)}</div>
                <div style={{ color: 'var(--ink-soft)' }}>{formatCountdown(d.dueAt)}</div>
                <span className={`chip ${confirmed ? 'chip--ok' : 'chip--warn'}`}>
                  {confirmed ? '● Confirmée' : '◇ Non vérifiée — à confirmer'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="disclaimer">
        Les dates relevées par l’outil restent non vérifiées jusqu’à votre confirmation.
      </p>
    </section>
  );
}
