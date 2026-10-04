import Fastify from 'fastify';
import {
  applyMigrations,
  createDb,
  PostgresCaseStore,
  seedDemoFixtures,
  withTransaction,
} from '@lexora/db';
import { parseApiEnv } from '@lexora/shared';
import { MemoryStore, type CaseStore } from '@lexora/shared/pipeline';
import {
  createDeps,
  jsonLogger,
  parseConfig as parseWorkerConfig,
  processInbound,
} from '@lexora/worker';

import { parseDemoConfig } from './demo-config.js';
import { demoRoutes } from './demo-page.js';
import { applyDemoPhones } from './demo-phones.js';
import { createIncomingMessageHandler } from './incoming-message-handler.js';
import { InProcessQueue } from './inprocess-queue.js';
import { MediaCache } from './media-cache.js';
import { registerKapsoWebhook } from './routes/kapso-webhook.js';
import { createKapsoClient } from './whatsapp/kapso.js';
import { toWhatsApp } from './whatsapp/phone.js';

const config = parseApiEnv(process.env);
const demo = parseDemoConfig(process.env);
const workerConfig = parseWorkerConfig({
  ...process.env,
  // The worker's allowlist is the demo allowlist: one list, read once.
  DEMO_ALLOWED_NUMBERS: [...demo.allowedNumbers].join(','),
});

const app = Fastify({ logger: true });
const kapsoClient = createKapsoClient({
  apiKey: config.kapsoApiKey,
  phoneNumberId: config.kapsoPhoneNumberId,
});

const memoryStore = process.env.DATA_MODE === 'memory' ? MemoryStore.seeded() : null;
if (!memoryStore) await applyMigrations(config.databaseUrl);
const database = memoryStore
  ? null
  : createDb({ connectionString: config.databaseUrl, maxConnections: 5 });
if (database) await withTransaction(database.db, (tx) => seedDemoFixtures(tx, process.env));
const store: CaseStore = memoryStore ?? new PostgresCaseStore(database!.db);
let demoPhones = false;
if (memoryStore) {
  try {
    demoPhones = applyDemoPhones(memoryStore, demo);
  } catch (err) {
    console.error(`Refusing to start: ${(err as Error).message}`);
    process.exit(1);
  }
}

const media = new MediaCache();
const workerDeps = createDeps(workerConfig, store, jsonLogger, {
  downloader: media,
  messenger: {
    async send(toE164, body) {
      const providerMessageId = await kapsoClient.sendText(toWhatsApp(toE164), body);
      return { status: 'sent', providerMessageId };
    },
  },
});
const queue = new InProcessQueue(async (messageId) => {
  try {
    await processInbound(workerDeps, messageId);
  } catch (err) {
    app.log.error({ err, messageId }, 'process-inbound failed');
  }
});

app.get('/health', async () => ({ status: 'ok' }));
await app.register(registerKapsoWebhook, {
  kapsoClient,
  phoneNumberId: config.kapsoPhoneNumberId,
  webhookSecret: config.kapsoWebhookSecret,
  handleIncomingMessage: createIncomingMessageHandler({
    store,
    openIntake: workerConfig.openIntake,
    queue,
    media,
    log: app.log,
  }),
});
// The lightweight jury screen is kept for the explicit in-memory demo mode.
if (memoryStore) await app.register(demoRoutes, { store: memoryStore });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => database?.close()));
}

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(
  {
    ai: workerConfig.aiMode,
    messaging: workerConfig.messagingMode,
    legal: workerConfig.legalContextMode,
    openIntake: workerConfig.openIntake,
    allowed: demo.allowedNumbers.size,
    demoPhones,
  },
  'lexora api ready',
);
