/**
 * Data access for the lawyer dashboard.
 *
 * Reads the backend's read API (apps/api, `/api/cases`), proxied by Vite in development.
 * `VITE_USE_MOCKS=1` keeps the fictional demo data from `src/mocks` (offline rehearsal).
 */

import { demoCaseDetail, demoCaseList } from '@/mocks/demo';
import type { CaseDetail, CaseList } from '@/types/lexora';

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === '1';
const LATENCY_MS = 180;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

function later<T>(produce: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try {
        resolve(produce());
      } catch (err) {
        reject(err);
      }
    }, LATENCY_MS);
  });
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'Dossier introuvable' : `Erreur ${res.status}`);
  return (await res.json()) as T;
}

export const fetchCases = (): Promise<CaseList> =>
  USE_MOCKS ? later(demoCaseList) : getJson<CaseList>('/api/cases');

export const fetchCase = (caseId: string): Promise<CaseDetail> =>
  USE_MOCKS
    ? later(() => {
        const detail = demoCaseDetail(caseId);
        if (!detail) throw new ApiError(404, 'Dossier introuvable');
        return detail;
      })
    : getJson<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`);

export const fetchHealth = (): Promise<{ status: 'ok' }> =>
  USE_MOCKS ? later(() => ({ status: 'ok' as const })) : getJson<{ status: 'ok' }>('/health');
