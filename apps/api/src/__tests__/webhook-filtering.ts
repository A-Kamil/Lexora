import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPhone } from '../webhook.js';
import { CLIENT, LAWYER, UNKNOWN, inbound, post, setup } from './support/helpers.js';

async function assertIgnored(s: ReturnType<typeof setup>, from: string) {
  const res = await post(s.app, inbound({ From: `whatsapp:${from}` }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '<Response/>');
  assert.equal(s.store.messages.length, 0);
  assert.equal(s.queue.jobs.length, 0);
  await s.app.close();
}

test('webhook: sender outside DEMO_ALLOWED_NUMBERS -> 200, nothing stored', async () => {
  await assertIgnored(setup({ DEMO_ALLOWED_NUMBERS: LAWYER }), CLIENT);
});

test('webhook: empty DEMO_ALLOWED_NUMBERS refuses everyone', async () => {
  await assertIgnored(setup({ DEMO_ALLOWED_NUMBERS: '' }), CLIENT);
});

test('webhook: unknown participant (absent) -> 200, nothing stored', async () => {
  await assertIgnored(setup(), UNKNOWN);
});

test('webhook: ambiguous participant (two open cases) -> 200, nothing stored', async () => {
  const s = setup();
  s.store.cases.push({ id: 'c-2', title: 'Second fictional case', jurisdiction: 'FR', language: 'en', timezone: 'Europe/Paris', clientId: 'p-client', lawyerId: 'p-lawyer', open: true });
  await assertIgnored(s, CLIENT);
});

test('webhook: message from the lawyer -> 200, nothing stored', async () => {
  await assertIgnored(setup(), LAWYER);
});

test('maskPhone hides the middle of the number', () => {
  assert.equal(maskPhone('+33600000001'), '+336******01');
});
