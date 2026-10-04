export { parseApiEnv, parseWorkerEnv } from './config.js';
export type ApiConfig = ReturnType<typeof import('./config.js').parseApiEnv>;
export type WorkerConfig = ReturnType<
  typeof import('./config.js').parseWorkerEnv
>;
