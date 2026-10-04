/**
 * Single-shot data-source probe (on mount and on each explicit `retry()`),
 * bounded by a 5-second timeout. Feeds the "données indisponibles" banner.
 */

import { useCallback, useEffect, useState } from 'react';
import { fetchHealth } from '@/lib/api';

export type HealthStatus = 'checking' | 'ok' | 'unreachable';

const PROBE_TIMEOUT_MS = 5_000;

export function useHealthProbe(): { status: HealthStatus; retry: () => void } {
  const [status, setStatus] = useState<HealthStatus>('checking');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
    });

    Promise.race([fetchHealth(), timeout]).then(
      () => {
        if (!cancelled) setStatus('ok');
      },
      () => {
        if (!cancelled) setStatus('unreachable');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const retry = useCallback(() => {
    setStatus('checking');
    setNonce((n) => n + 1);
  }, []);

  return { status, retry };
}
