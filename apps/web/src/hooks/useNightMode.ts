import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'lexora.night';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function apply(next: boolean): void {
  const doToggle = () => {
    document.body.classList.toggle('night', next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
    listeners.forEach((cb) => cb());
  };

  /**
   * View Transitions API cross-fades the entire page during the class swap,
   * so every variable-driven surface animates together even when individual
   * elements have no CSS transition of their own.
   */
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  };
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (typeof doc.startViewTransition === 'function' && !reduceMotion) {
    doc.startViewTransition(doToggle);
  } else {
    doToggle();
  }
}

if (typeof window !== 'undefined') {
  apply(read());
}

export function useNightMode() {
  const night = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => false,
  );
  const toggle = useCallback(() => apply(!read()), []);
  const setNight = useCallback((next: boolean) => apply(next), []);
  return { night, toggle, setNight };
}
