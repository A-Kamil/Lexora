import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inbound, post, setup } from './support/helpers.js';

test('webhook: invalid signature -> 403, nothing stored', async () => {
  const { app, store, queue } = setup();
  const res = await post(app, inbound(), 'bm90LWEtdmFsaWQtc2lnbmF0dXJl');
  assert.equal(res.statusCode, 403);
  assert.equal(store.messages.length, 0);
  assert.equal(queue.jobs.length, 0);
  await app.close();
});

test('webhook: missing signature -> 403', async () => {
  const { app } = setup();
  const res = await app.inject({
    method: 'POST', url: '/webhooks/twilio',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(inbound()).toString(),
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test('webhook: valid signature -> 200 empty TwiML', async () => {
  const { app } = setup();
  const res = await post(app, inbound());
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^application\/xml/);
  assert.equal(res.body, '<Response/>');
  await app.close();
});

test('webhook: signed but malformed -> 400', async () => {
  const { app } = setup();
  const { MessageSid: _omit, ...noSid } = inbound();
  assert.equal((await post(app, noSid)).statusCode, 400);
  assert.equal((await post(app, inbound({ AccountSid: 'ACother' }))).statusCode, 400);
  assert.equal((await post(app, inbound({ From: '+33600000001' }))).statusCode, 400);
  await app.close();
});
