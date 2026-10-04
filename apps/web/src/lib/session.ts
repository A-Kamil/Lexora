/**
 * Demo-only session. There is no authentication in the demo: the login form
 * is design only and signing in just records who the (fictional) lawyer is, so the routes can gate
 * on it. Real authentication is a separate, later piece of work.
 */

import type { Session } from '@/types/lexora';

const SESSION_KEY = 'lexora.session';
const DEMO_LAWYER = 'Me John Smith';

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function startSession(): Session {
  const session: Session = {
    lawyerName: DEMO_LAWYER,
    startedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* storage disabled — the session simply won't persist across reloads */
  }
  return session;
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
