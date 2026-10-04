import { MemoryQueue, MemoryStore } from '@lexora/shared';
import { buildApp } from '../../app.js';
import { parseConfig, type ApiConfig } from '../../config.js';

export const TEST_TOKEN = 'test-auth-token-not-a-secret';
export const TEST_BASE_URL = 'https://lexora.test';
export const TEST_ACCOUNT_SID = 'AC00000000000000000000000000000000';
export const CLIENT = '+33600000001';
export const LAWYER = '+33600000002';
export const UNKNOWN = '+33600000003';

export function testConfig(overrides: Record<string, string> = {}): ApiConfig {
  return parseConfig({
    APP_MODE: 'test',
    PUBLIC_BASE_URL: TEST_BASE_URL,
    TWILIO_AUTH_TOKEN: TEST_TOKEN,
    TWILIO_ACCOUNT_SID: TEST_ACCOUNT_SID,
    DEMO_ALLOWED_NUMBERS: [CLIENT, LAWYER, UNKNOWN].join(','),
    ...overrides,
  });
}

export function setup(overrides: Record<string, string> = {}) {
  const store = MemoryStore.seeded();
  const queue = new MemoryQueue();
  const app = buildApp({ store, queue, config: testConfig(overrides) });
  return { store, queue, app };
}
