/**
 * Re-runs `fetcher` immediately and then every `intervalMs` (10 s by default).
 *
 * - A failed refresh keeps the last good data and exposes `error`, so a lawyer
 *   never loses sight of a case because of one dropped request.
 * - Polling pauses while the tab is hidden and refreshes as soon as it returns.
 * - `fetcher` must be referentially stable (wrap it in `useCallback`).
 */

import { useCallback, useEffect, useState } from 'react';

export const POLL_INTERVAL_MS = 10_000;

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  /** Epoch ms of the last successful refresh. */
  updatedAt: number | null;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number = POLL_INTERVAL_MS,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const run = () => {
      fetcher().then(
        (next) => {
          if (cancelled) return;
          setData(next);
          setError(null);
          setUpdatedAt(Date.now());
        },
        (err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };

    run();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetcher, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, updatedAt, refresh };
}
