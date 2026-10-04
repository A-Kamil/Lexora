import Fastify from 'fastify';
import { parseApiEnv } from '@lexora/shared';
import { MemoryStore } from '@lexora/shared/pipeline';
import { createDeps, jsonLogger, parseConfig as parseWorkerConfig, processInbound } from '@lexora/worker';

import { parseDemoConfig } from './demo-config.js';
import { demoRoutes } from './demo-page.js';
import { applyDemoPhones } from './demo-phones.js';
import { createIncomingMessageHandler } from './incoming-message-handler.js';
import { InProcessQueue } from './inprocess-queue.js';
import { MediaCache } from './media-cache.js';
import { loadStore, saveStore } from './store-file.js';
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

// Memory store until packages/db implements CaseStore, saved to a JSON file so a restart keeps the cases.
const loaded = demo.storeFile ? loadStore(demo.storeFile) : null;
const store = loaded ?? MemoryStore.seeded();
const persist = () => {
  if (!demo.storeFile) return;
  try {
    saveStore(store, demo.storeFile);
  } catch (err) {
    app.log.error({ err }, 'case store could not be saved');
  }
};
let demoPhones: boolean;
try {
  demoPhones = applyDemoPhones(store, demo);
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  process.exit(1);
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
  persist(); // the inbound message, saved by the webhook just before
  try {
    await processInbound(workerDeps, messageId);
  } catch (err) {
    app.log.error({ err, messageId }, 'process-inbound failed');
  } finally {
    persist();
  }
});

app.get('/health', async () => ({ status: 'ok' }));
await app.register(registerKapsoWebhook, {
  kapsoClient,
  phoneNumberId: config.kapsoPhoneNumberId,
  webhookSecret: config.kapsoWebhookSecret,
  handleIncomingMessage: createIncomingMessageHandler({ store, openIntake: workerConfig.openIntake, queue, media, log: app.log }),
});
// Read-only jury screen over the in-memory store.
await app.register(demoRoutes, { store });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(
  {
    ai: workerConfig.aiMode,
    messaging: workerConfig.messagingMode,
    legal: workerConfig.legalContextMode,
    openIntake: workerConfig.openIntake,
    storeFile: demo.storeFile ?? 'off',
    casesLoaded: loaded ? store.cases.length : 0,
    allowed: demo.allowedNumbers.size,
    demoPhones,
  },
  'lexora api ready',
);
