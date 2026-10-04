import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './support/helpers.js';

test('GET /health/live returns ok', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok' });
  await app.close();
});
