/** Ambient clock for the header: 24-hour, tabular digits, ticks once a second. */

import { useEffect, useState } from 'react';

export function Clock() {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const date = now.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
  const time = now.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return (
    <div
      className="flex items-center uppercase"
      style={{
        gap: 10,
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: '0.18em',
        lineHeight: 1.4,
        color: 'var(--ink-soft)',
      }}
      aria-label={`Heure actuelle : ${date}, ${time}`}
    >
      <span>{date}</span>
      <span aria-hidden="true" style={{ color: 'var(--ink-muted)' }}>
        ·
      </span>
      <span className="tabular" style={{ color: 'var(--ink)' }}>
        {time}
      </span>
    </div>
  );
}
