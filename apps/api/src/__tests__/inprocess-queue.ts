import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessQueue } from '../inprocess-queue.js';

test('InProcessQueue records the job and runs it after enqueue returns', async () => {
  const ran: string[] = [];
  const queue = new InProcessQueue(async (id) => { ran.push(id); });
  await queue.enqueue('process-inbound', { messageId: 'm-1' });
  assert.deepEqual(ran, []);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, ['m-1']);
  assert.deepEqual(queue.inner.jobs, [{ name: 'process-inbound', payload: { messageId: 'm-1' } }]);
});
