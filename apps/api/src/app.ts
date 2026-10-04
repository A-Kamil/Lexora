import Fastify, { type FastifyInstance } from 'fastify';
import type { CaseStore, JobQueue } from '@lexora/shared';
import type { ApiConfig } from './config.js';
import { webhookRoutes } from './webhook.js';

export type { ApiConfig } from './config.js';
export { parseConfig } from './config.js';

export interface AppDeps {
  store: CaseStore;
  queue: JobQueue;
  config: ApiConfig;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;
  const app = Fastify({ logger: config.appMode !== 'test' });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/health/live', async () => ({ status: 'ok' }));

  void app.register(webhookRoutes, deps);

  return app;
}
