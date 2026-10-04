import { createContext } from 'react';
import type { PollingState } from '@/hooks/usePolling';
import type { CaseList } from '@/types/lexora';

export const CasesContext = createContext<PollingState<CaseList> | null>(null);
