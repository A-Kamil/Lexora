import { MemoryStore, type InboundMedia } from '@lexora/shared';
import { parseConfig } from '../config.js';
import { FakeAi, FakeDownloader, FakeMessenger, MockLegal } from '../fake.js';
import { silentLogger } from '../ports.js';
import type { WorkerDeps } from '../process.js';

let n = 0;

/** Seeded fictional store + fakes; `env` overrides config. */
export function setup(env: Record<string, string> = {}, files: ConstructorParameters<typeof FakeDownloader>[0] = {}) {
  const store = MemoryStore.seeded();
  const ai = new FakeAi();
  const messenger = new FakeMessenger();
  const legal = new MockLegal();
  const deps: WorkerDeps = {
    store, ai, messenger, legal,
    clock: () => new Date('2026-10-04T22:00:00Z'),
    config: parseConfig(env),
    downloader: new FakeDownloader(files),
    log: silentLogger,
    urgencyCriteria: 'CRITICAL = garde à vue en cours.',
  };
  return { store, ai, messenger, legal, deps };
}

/** Inbound message from the seeded client; media kept on the stored row (the contract has no media field yet). */
export async function inbound(store: MemoryStore, text: string, media: InboundMedia[] = []) {
  const { message } = await store.saveInboundMessage({
    caseId: 'c-1', personId: 'p-client', provider: 'twilio', providerMessageId: `SM-test-${++n}`, text, media, receivedAt: '2026-10-04T21:59:00Z',
  });
  Object.assign(message, { media });
  return message.id;
}
