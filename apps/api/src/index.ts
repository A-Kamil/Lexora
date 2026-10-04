import { MemoryStore } from '@lexora/shared';
import { buildApp } from './app.js';
import { parseConfig } from './config.js';
import { applyDemoPhones } from './demo-phones.js';
import { InProcessQueue, workerRunner } from './inprocess-queue.js';

const config = parseConfig(process.env);

if (config.storeMode !== 'memory') {
  console.error(`STORE_MODE=${config.storeMode} is not available yet (packages/db pending); use STORE_MODE=memory.`);
  process.exit(1);
}

const store = MemoryStore.seeded();
let demoPhones: boolean;
try {
  demoPhones = applyDemoPhones(store, config);
} catch (err) {
  console.error(`Refusing to start: ${(err as Error).message}`);
  process.exit(1);
}
let app: ReturnType<typeof buildApp> | undefined;
const queue: InProcessQueue = new InProcessQueue(workerRunner(() => ({ store, queue, log: app!.log })));
app = buildApp({ store, queue, config });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ storeMode: config.storeMode, allowed: config.allowedNumbers.size, demoPhones }, 'lexora api ready');
