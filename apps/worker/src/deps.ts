import type { CaseStore } from '@lexora/shared/pipeline';
import type { WorkerConfig } from './config.js';
import { FakeAi, FakeMessenger } from './fake.js';
import { liveAi, liveLegal } from './live.js';
import { jsonLogger, type Logger, type MediaDownloader, type Messenger } from './ports.js';
import type { WorkerDeps } from './process.js';

/** The WhatsApp transport (Kapso) lives in the API, which receives the webhook and owns the provider client. */
export interface Transport { messenger: Messenger; downloader: MediaDownloader }

/** Wires ports from the modes. Legal context always goes through @lexora/ai, which handles disabled/mock offline. */
export function createDeps(config: WorkerConfig, store: CaseStore, log: Logger = jsonLogger, transport?: Transport): WorkerDeps {
  if (config.messagingMode === 'live' && !transport) throw new Error('MESSAGING_MODE=live needs a WhatsApp transport (run through the API)');
  return {
    store,
    config,
    log,
    clock: () => new Date(),
    ai: config.aiMode === 'live' ? liveAi(config) : new FakeAi(),
    messenger: config.messagingMode === 'live' && transport ? transport.messenger : new FakeMessenger(),
    legal: liveLegal(config),
    ...(transport ? { downloader: transport.downloader } : {}),
  };
}
