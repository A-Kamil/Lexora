/**
 * One shared 10-second poll of the case list for every authenticated screen
 * (case list, global urgent-case bar), instead of one poll per component.
 */

import type { ReactNode } from 'react';
import { fetchCases } from '@/lib/api';
import { usePolling } from '@/hooks/usePolling';
import { CasesContext } from './casesContext';

export function CasesProvider({ children }: { children: ReactNode }) {
  const polling = usePolling(fetchCases);
  return <CasesContext.Provider value={polling}>{children}</CasesContext.Provider>;
}
