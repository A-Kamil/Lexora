import type { CaseStore } from '@lexora/shared';
import type { WorkerConfig } from './config.js';
import { FakeAi, FakeMessenger } from './fake.js';
import { liveAi, liveLegal, twilioDownloader, twilioMessenger } from './live.js';
import { jsonLogger, type Logger } from './ports.js';
import type { WorkerDeps } from './process.js';

/** Wires ports from the modes. Legal context always goes through @lexora/ai, which handles disabled/mock offline. */
export function createDeps(config: WorkerConfig, store: CaseStore, log: Logger = jsonLogger): WorkerDeps {
  const { accountSid, authToken } = config.twilio;
  return {
    store,
    config,
    log,
    clock: () => new Date(),
    ai: config.aiMode === 'live' ? liveAi(config) : new FakeAi(),
    messenger: config.messagingMode === 'live' ? twilioMessenger(config) : new FakeMessenger(),
    legal: liveLegal(config),
    ...(accountSid && authToken ? { downloader: twilioDownloader(config) } : {}),
  };
}
