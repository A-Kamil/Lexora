import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InboundMessageInput } from '@lexora/shared';
import { inbound, post, setup } from './support/helpers.js';

test('webhook: one client message -> 1 message stored + 1 job queued', async () => {
  const { app, store, queue } = setup();
  const res = await post(app, inbound());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '<Response/>');
  assert.equal(store.messages.length, 1);
  const msg = store.messages[0]!;
  assert.equal(msg.caseId, 'c-1');
  assert.equal(msg.personId, 'p-client');
  assert.equal(msg.text, 'Fictional test message');
  assert.equal(msg.providerMessageId, 'SM00000000000000000000000000000001');
  assert.deepEqual(queue.jobs, [{ name: 'process-inbound', payload: { messageId: msg.id } }]);
  await app.close();
});

test('webhook: same MessageSid twice -> still 1 message and 1 job', async () => {
  const { app, store, queue } = setup();
  assert.equal((await post(app, inbound())).statusCode, 200);
  assert.equal((await post(app, inbound())).statusCode, 200);
  assert.equal(store.messages.length, 1);
  assert.equal(queue.jobs.length, 1);
  await app.close();
});

test('webhook: media fields fill media[]', async () => {
  const { app, store, queue } = setup();
  const inputs: InboundMessageInput[] = [];
  const save = store.saveInboundMessage.bind(store);
  store.saveInboundMessage = async (input) => { inputs.push(input); return save(input); };
  const res = await post(app, inbound({
    Body: '',
    NumMedia: '2',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0',
    MediaContentType0: 'audio/ogg',
    MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME1',
    MediaContentType1: 'application/pdf',
  }));
  assert.equal(res.statusCode, 200);
  assert.equal(store.messages.length, 1);
  assert.equal(queue.jobs.length, 1);
  assert.equal(store.messages[0]!.kind, 'document');
  assert.deepEqual(inputs[0]!.media, [
    { index: 0, url: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME0', contentType: 'audio/ogg' },
    { index: 1, url: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM0/Media/ME1', contentType: 'application/pdf' },
  ]);
  await app.close();
});

test('webhook: NumMedia announces a missing media -> 400', async () => {
  const { app, store } = setup();
  assert.equal((await post(app, inbound({ NumMedia: '1' }))).statusCode, 400);
  assert.equal(store.messages.length, 0);
  await app.close();
});

test('webhook: storage failure -> 503', async () => {
  const { app, store } = setup();
  store.saveInboundMessage = async () => { throw new Error('db down'); };
  assert.equal((await post(app, inbound())).statusCode, 503);
  await app.close();
});

test('webhook: body over 256 KiB -> 413', async () => {
  const { app } = setup();
  assert.equal((await post(app, inbound({ Body: 'x'.repeat(300 * 1024) }))).statusCode, 413);
  await app.close();
});
