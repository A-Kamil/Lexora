import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryStore, type CaseStore, type JobQueue } from '@lexora/shared';
import type { ApiConfig } from './config.js';
import { webhookRoutes } from './webhook.js';
import { demoRoutes } from './demo-page.js';

export type { ApiConfig } from './config.js';
export { parseConfig } from './config.js';

export interface AppDeps {
  store: CaseStore;
  queue: JobQueue;
  config: ApiConfig;
  /** Defaults to on, except with APP_MODE=test. */
  logger?: boolean;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({ logger: deps.logger ?? config.appMode !== 'test' });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/live', async () => ({ status: 'ok' }));

  void app.register(webhookRoutes, deps);
  // Read-only jury screen: demo mode and in-memory store only.
  if (config.appMode === 'demo' && deps.store instanceof MemoryStore) {
    void app.register(demoRoutes, { store: deps.store });
  }

  return app;
}
