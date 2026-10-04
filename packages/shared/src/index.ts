import { parseApiEnv, parseWorkerEnv } from './config.js';

export { parseApiEnv, parseWorkerEnv };

// Same intent as on main — the config types are derived from the parsers rather than
// declared twice — written with a top-level import so `consistent-type-imports` is happy.
export type ApiConfig = ReturnType<typeof parseApiEnv>;
export type WorkerConfig = ReturnType<typeof parseWorkerEnv>;

export * from './domain.js';
export * from './phone.js';
export * from './requests.js';
