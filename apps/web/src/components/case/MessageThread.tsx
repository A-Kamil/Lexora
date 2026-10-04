import { formatDateTime } from '@/lib/legal';
import type { CaseMessage } from '@/types/lexora';

interface Props {
  messages: CaseMessage[];
  timezone: string;
  documentNames: Record<string, string>;
}

export function MessageThread({ messages, timezone, documentNames }: Props) {
  return (
    <section className="panel" aria-label="Échanges">
      <p className="section-label">Échanges avec le client</p>
      {messages.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--ink-muted)' }}>Aucun message.</p>
      ) : (
        <ol className="thread">
          {messages.map((m) => (
            <li key={m.id} className={`bubble bubble--${m.direction}`}>
              <div className="bubble__meta">
                <strong>{m.author}</strong>
                <span className="tabular">{formatDateTime(m.createdAt, timezone)}</span>
              </div>
              <p className="bubble__text">{m.text}</p>
              {m.documentIds.length > 0 ? (
                <p className="bubble__docs">
                  Pièce{m.documentIds.length > 1 ? 's' : ''} jointe
                  {m.documentIds.length > 1 ? 's' : ''} :{' '}
                  {m.documentIds.map((id) => documentNames[id] ?? 'document').join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
