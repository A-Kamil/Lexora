import { MemoryQueue, type CaseStore, type JobQueue } from '@lexora/shared';
import type { FastifyBaseLogger } from 'fastify';

/**
 * PROVISIONAL (STORE_MODE=memory only): the in-memory queue does not cross processes, so the API runs
 * the worker's job itself, after the webhook has replied. With STORE_MODE=db this is replaced by pg-boss.
 */
export class InProcessQueue implements JobQueue {
  readonly inner = new MemoryQueue();
  constructor(private readonly onJob: (messageId: string) => Promise<void>) {}

  async enqueue(name: 'process-inbound', payload: { messageId: string }): Promise<void> {
    await this.inner.enqueue(name, payload);
    setImmediate(() => void this.onJob(payload.messageId));
  }
}

type ProcessInbound = (deps: { store: CaseStore; queue: JobQueue; log: FastifyBaseLogger }, messageId: string) => Promise<unknown>;

/** Loads `processInbound` from @lexora/worker if it exists; otherwise every job is logged as "worker absent". */
export function workerRunner(getDeps: () => { store: CaseStore; queue: JobQueue; log: FastifyBaseLogger }) {
  let loaded: Promise<ProcessInbound | null> | undefined;
  const load = async (log: FastifyBaseLogger): Promise<ProcessInbound | null> => {
    const specifier = '@lexora/worker'; // variable: not resolved at compile time, the worker may not exist yet
    try {
      const mod: { processInbound?: unknown; createDeps?: unknown; parseConfig?: unknown } = await import(specifier);
      if (typeof mod.processInbound === 'function' && typeof mod.createDeps === 'function' && typeof mod.parseConfig === 'function') {
        // Worker deps (AI, messaging, legal sources) come from the worker's own config, read from the environment.
        const config = (mod.parseConfig as (env: NodeJS.ProcessEnv) => unknown)(process.env);
        const run = mod.processInbound as (deps: unknown, messageId: string) => Promise<unknown>;
        const create = mod.createDeps as (config: unknown, store: CaseStore) => unknown;
        return (deps, messageId) => run(create(config, deps.store), messageId);
      }
      if (typeof mod.processInbound === 'function') return mod.processInbound as ProcessInbound;
      log.warn('worker absent: @lexora/worker has no processInbound export');
    } catch (err) {
      log.warn({ code: (err as { code?: string }).code }, 'worker absent: @lexora/worker could not be loaded');
    }
    return null;
  };

  return async (messageId: string) => {
    const deps = getDeps();
    loaded ??= load(deps.log);
    const processInbound = await loaded;
    if (!processInbound) {
      deps.log.warn({ messageId }, 'worker absent: job left in memory queue');
      return;
    }
    try {
      await processInbound(deps, messageId);
    } catch (err) {
      deps.log.error({ err, messageId }, 'process-inbound failed');
    }
  };
}
