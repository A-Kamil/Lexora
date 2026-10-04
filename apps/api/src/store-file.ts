import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MemoryStore } from '@lexora/shared/pipeline';

/**
 * PROVISIONAL persistence until packages/db implements CaseStore: the in-memory store is written to one JSON file
 * after every change and reloaded at startup, so restarting the API no longer loses the cases.
 * The file holds client conversations: it lives under apps/api/data/ (git-ignored) with owner-only permissions.
 */
const FIELDS = ['people', 'cases', 'messages', 'documents', 'analyses', 'outbound'] as const;

export function loadStore(path: string): MemoryStore | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const data = JSON.parse(raw) as Record<string, unknown>;
  const store = new MemoryStore();
  for (const f of FIELDS) {
    if (Array.isArray(data[f])) (store as unknown as Record<string, unknown[]>)[f] = data[f] as unknown[];
  }
  return store;
}

export function saveStore(store: MemoryStore, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const snapshot = Object.fromEntries(FIELDS.map((f) => [f, store[f]]));
  // Write then rename: a crash mid-write never leaves a truncated store.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(tmp, path);
}
