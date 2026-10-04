import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import twilio from 'twilio';
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
  const app = buildApp({ store, queue, config: testConfig(overrides), logger: false });
  return { store, queue, app };
}

export function inbound(fields: Record<string, string> = {}): Record<string, string> {
  return {
    From: `whatsapp:${CLIENT}`,
    To: 'whatsapp:+33600000009',
    Body: 'Fictional test message',
    MessageSid: 'SM00000000000000000000000000000001',
    AccountSid: TEST_ACCOUNT_SID,
    NumMedia: '0',
    ...fields,
  };
}

/** POST a form to the webhook, signed with the test token unless a signature is given. */
export function post(app: FastifyInstance, fields: Record<string, string>, signature?: string): Promise<LightMyRequestResponse> {
  const sig = signature ?? twilio.getExpectedTwilioSignature(TEST_TOKEN, TEST_BASE_URL + '/webhooks/twilio', fields);
  return app.inject({
    method: 'POST',
    url: '/webhooks/twilio',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    payload: new URLSearchParams(fields).toString(),
  });
}
