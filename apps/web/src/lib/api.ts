/**
 * Data access for the lawyer dashboard.
 *
 * The backend has no read API yet, so these functions resolve fictional demo
 * data from `src/mocks`. Components only depend on this module's signatures:
 * when the read API exists, replace the bodies with `fetch` calls and nothing
 * else in the app changes.
 */

import { demoCaseDetail, demoCaseList } from '@/mocks/demo';
import type { CaseDetail, CaseList } from '@/types/lexora';

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

export const fetchCases = (): Promise<CaseList> => later(demoCaseList);

export const fetchCase = (caseId: string): Promise<CaseDetail> =>
  later(() => {
    const detail = demoCaseDetail(caseId);
    if (!detail) throw new ApiError(404, 'Dossier introuvable');
    return detail;
  });

export const fetchHealth = (): Promise<{ status: 'ok' }> =>
  later(() => ({ status: 'ok' as const }));
