export { parseConfig, type WorkerConfig } from './config.js';
export type { AiPort, Messenger, LegalPort, MediaDownloader, Logger } from './ports.js';
export { jsonLogger, silentLogger, maskPhone } from './ports.js';
export { FakeAi, FakeMessenger, MockLegal, FakeDownloader, fakeTriage } from './fake.js';
export { liveAi, liveLegal } from './live.js';
export { processInbound, formatLawyerAlert, defaultUrgencyCriteria, CLIENT_REPLY_ALERTED, CLIENT_REPLY_RECEIVED, type WorkerDeps, type ProcessResult } from './process.js';
export { createDeps, type Transport } from './deps.js';
