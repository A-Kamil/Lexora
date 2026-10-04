import { useContext } from 'react';
import type { PollingState } from '@/hooks/usePolling';
import type { CaseList } from '@/types/lexora';
import { CasesContext } from './casesContext';

export function useCases(): PollingState<CaseList> {
  const value = useContext(CasesContext);
  if (!value) throw new Error('useCases must be used inside <CasesProvider>');
  return value;
}
