import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInbound, formatLawyerAlert, CLIENT_REPLY_ALERTED, CLIENT_REPLY_RECEIVED } from '../process.js';
import { inbound, setup } from './helpers.js';

test('garde à vue → 1 CRITICAL analysis, 1 simulated lawyer alert, 1 client acknowledgement', async () => {
  const { store, messenger, deps } = setup();
  const id = await inbound(store, 'Bonsoir, mon fils est en garde à vue au commissariat.');
  const r = await processInbound(deps, id);
  assert.equal(r.status, 'processed');
  assert.equal(store.analyses.length, 1);
  assert.equal((store.analyses[0]!.result as { analysis: { urgency: string } }).analysis.urgency, 'CRITICAL');
  assert.equal(store.analyses[0]!.triggerKey, `message:${id}:v1`);

  const alerts = store.outbound.filter((o) => o.purpose === 'lawyer_alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.status, 'simulated');
  assert.equal(alerts[0]!.personId, 'p-lawyer');
  assert.match(alerts[0]!.text, /^LEXORA — CRITICAL\nSarah Miller \(fictional\) — Fictional criminal case\n/);
  assert.match(alerts[0]!.text, /À faire : rappeler le client maintenant\.$/);

  const replies = store.outbound.filter((o) => o.purpose === 'client_reply');
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.text, CLIENT_REPLY_ALERTED);
  assert.equal(replies[0]!.status, 'simulated');
  assert.deepEqual(messenger.sent.map((s) => s.to), ['+33600000002', '+33600000001']);
});

test('LOW message → analysis, no lawyer alert', async () => {
  const { store, deps } = setup();
  const id = await inbound(store, 'Quels sont les horaires du cabinet ?');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.urgency, 'LOW');
  assert.equal(store.analyses.length, 1);
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 0);
  assert.deepEqual(store.outbound.map((o) => o.text), [CLIENT_REPLY_RECEIVED]);
});

test('same message processed twice → 1 analysis, 1 alert', async () => {
  const { store, messenger, deps } = setup();
  const id = await inbound(store, 'Il a été arrêté ce soir.');
  await processInbound(deps, id);
  const second = await processInbound(deps, id);
  assert.equal(second.status, 'skipped');
  assert.equal(store.analyses.length, 1);
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 1);
  assert.equal(messenger.sent.length, 2);
});

test('unknown message → nothing happens', async () => {
  const { store, deps } = setup();
  assert.deepEqual(await processInbound(deps, 'nope'), { status: 'skipped', reason: 'message_not_found' });
  assert.equal(store.analyses.length, 0);
});

test('live messaging refuses numbers outside DEMO_ALLOWED_NUMBERS', async () => {
  const { store, messenger, deps } = setup({ MESSAGING_MODE: 'live', DEMO_ALLOWED_NUMBERS: '+33600000009' });
  const id = await inbound(store, 'garde à vue');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.alert, 'failed');
  assert.equal(messenger.sent.length, 0);
  assert.ok(store.outbound.every((o) => o.status === 'failed' && o.error === 'numéro non autorisé'));
  // the client is not told a lawyer was alerted when the alert did not go out
  assert.equal(store.outbound.find((o) => o.purpose === 'client_reply')!.text, CLIENT_REPLY_RECEIVED);
});

test('no lawyer assigned → no alert, analysis kept', async () => {
  const { store, deps } = setup();
  store.cases[0]!.lawyerId = null;
  const id = await inbound(store, 'garde à vue');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.alert, 'no_lawyer');
  assert.equal(store.analyses.length, 1);
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 0);
});

test('AI failure → conservative HIGH fallback still alerts the lawyer', async () => {
  const { store, deps } = setup();
  deps.ai.analyze = async () => { throw new Error('provider down'); };
  const id = await inbound(store, 'bonjour');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.analysisStatus, 'fallback');
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 1);
});

test('lawyer alert is capped at 1 200 characters', () => {
  const t = formatLawyerAlert({ urgency: 'HIGH', clientName: 'A'.repeat(500), caseTitle: 'B'.repeat(500), issue: 'C'.repeat(5000), urgencyReason: 'D'.repeat(5000) });
  assert.ok(t.length <= 1200);
  assert.ok(t.endsWith('rappeler le client maintenant.'));
});
