import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryQueue, MemoryStore } from '@lexora/shared';
import { buildApp } from '../app.js';
import { applyDemoPhones } from '../demo-phones.js';
import { inbound, post, testConfig } from './support/helpers.js';

const REAL_CLIENT = '+33600000011';
const REAL_LAWYER = '+33600000012';

test('demo phones: replace the seeded client and lawyer numbers', async () => {
  const store = MemoryStore.seeded();
  const config = testConfig({ DEMO_ALLOWED_NUMBERS: `${REAL_CLIENT},${REAL_LAWYER}`, DEMO_CLIENT_PHONE: REAL_CLIENT, DEMO_LAWYER_PHONE: REAL_LAWYER });
  assert.equal(applyDemoPhones(store, config), true);
  assert.equal((await store.resolveParticipant(REAL_CLIENT)).kind, 'found');
  assert.equal((await store.resolveParticipant('+33600000001')).kind, 'absent');

  // End to end: the real client phone is now accepted by the webhook.
  const queue = new MemoryQueue();
  const app = buildApp({ store, queue, config });
  assert.equal((await post(app, inbound({ From: `whatsapp:${REAL_CLIENT}` }))).statusCode, 200);
  assert.equal(store.messages.length, 1);
  assert.equal(queue.jobs.length, 1);
  await app.close();
});

test('demo phones: unset -> seeded store untouched', () => {
  const store = MemoryStore.seeded();
  assert.equal(applyDemoPhones(store, testConfig()), false);
  assert.equal(store.people[0]!.phoneE164, '+33600000001');
});

test('demo phones: refuse to start if not in DEMO_ALLOWED_NUMBERS', () => {
  const config = testConfig({ DEMO_ALLOWED_NUMBERS: REAL_CLIENT, DEMO_CLIENT_PHONE: REAL_CLIENT, DEMO_LAWYER_PHONE: REAL_LAWYER });
  assert.throws(() => applyDemoPhones(MemoryStore.seeded(), config), /DEMO_LAWYER_PHONE must also be listed in DEMO_ALLOWED_NUMBERS/);
});

test('demo phones: refuse to start if only one is set, or both are equal', () => {
  const allowed = { DEMO_ALLOWED_NUMBERS: `${REAL_CLIENT},${REAL_LAWYER}` };
  assert.throws(() => applyDemoPhones(MemoryStore.seeded(), testConfig({ ...allowed, DEMO_CLIENT_PHONE: REAL_CLIENT })), /set together/);
  assert.throws(() => applyDemoPhones(MemoryStore.seeded(), testConfig({ ...allowed, DEMO_CLIENT_PHONE: REAL_CLIENT, DEMO_LAWYER_PHONE: REAL_CLIENT })), /different/);
});

test('demo phones: non E.164 value rejected by config', () => {
  assert.throws(() => testConfig({ DEMO_CLIENT_PHONE: '0600000011' }));
});
