import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInbound, formatLawyerAlert, CLIENT_NOTICE_ALERTED, CLIENT_REPLY_RECEIVED } from '../process.js';
import { FAKE_INTAKE_FIRST } from '../fake.js';
import { inbound, setup } from './helpers.js';

test('garde à vue → 1 CRITICAL analysis, 1 lawyer alert, agent reply + "lawyer alerted" notice to the client', async () => {
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
  assert.deepEqual(replies.map((o) => o.text), [FAKE_INTAKE_FIRST, CLIENT_NOTICE_ALERTED]);
  assert.ok(replies.every((o) => o.status === 'simulated'));
  // agent reply, lawyer alert, then the notice
  assert.deepEqual(messenger.sent.map((s) => s.to), ['+33600000001', '+33600000002', '+33600000001']);
  // the agent's reply is part of the conversation it will read back
  assert.equal(store.messages.filter((m) => m.direction === 'outbound').length, 2);
});

test('LOW message → analysis, no lawyer alert', async () => {
  const { store, deps } = setup();
  const id = await inbound(store, 'Quels sont les horaires du cabinet ?');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.urgency, 'LOW');
  assert.equal(store.analyses.length, 1);
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 0);
  assert.deepEqual(store.outbound.map((o) => o.text), [FAKE_INTAKE_FIRST]);
});

test('same message processed twice → 1 analysis, 1 alert', async () => {
  const { store, messenger, deps } = setup();
  const id = await inbound(store, 'Il a été arrêté ce soir.');
  await processInbound(deps, id);
  const second = await processInbound(deps, id);
  assert.equal(second.status, 'skipped');
  assert.equal(store.analyses.length, 1);
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 1);
  assert.equal(messenger.sent.length, 3); // reply, alert, notice — nothing more on the re-run
});

test('conversation: second CRITICAL message → agent asks the next question, lawyer not re-alerted', async () => {
  const { store, messenger, deps } = setup();
  await processInbound(deps, await inbound(store, 'Mon fils est en garde à vue.'));
  const r = await processInbound(deps, await inbound(store, 'Il est en garde à vue au commissariat de Créteil depuis 22h.'));
  assert.equal(r.status === 'processed' && r.alert, null);
  assert.equal(store.outbound.filter((o) => o.purpose === 'lawyer_alert').length, 1);
  assert.equal(messenger.sent.at(-1)!.body, 'Merci. Avez-vous un document à nous transmettre (photo ou PDF) ?');
  // the agent saw its own first answer
  const second = (deps.ai as unknown as { calls: { converse: { history: { role: string }[]; caseFile: unknown }[] } }).calls.converse[1]!;
  assert.ok(second.history.some((t) => t.role === 'assistant'));
  // and was steered by the first message's analysis
  assert.deepEqual(second.caseFile, { urgency: 'CRITICAL', missingInformation: ['Lieu de la garde à vue'], requestedDocuments: [] });
});

test('intake agent failure → plain acknowledgement', async () => {
  const { store, deps } = setup();
  deps.ai.converse = async () => { throw new Error('provider down'); };
  await processInbound(deps, await inbound(store, 'Bonjour'));
  assert.equal(store.outbound.find((o) => o.purpose === 'client_reply')!.text, CLIENT_REPLY_RECEIVED);
});

test('unknown message → nothing happens', async () => {
  const { store, deps } = setup();
  assert.deepEqual(await processInbound(deps, 'nope'), { status: 'skipped', reason: 'message_not_found' });
  assert.equal(store.analyses.length, 0);
});

test('open intake: lawyer alert still needs the allowlist, the client reply goes back to the sender', async () => {
  const { store, messenger, deps } = setup({ MESSAGING_MODE: 'live', DEMO_ALLOWED_NUMBERS: '+33600000009' });
  const id = await inbound(store, 'garde à vue');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.alert, 'failed');
  assert.equal(r.status === 'processed' && r.reply, 'simulated'); // FakeMessenger: delivered, nothing left the machine
  assert.deepEqual(messenger.sent.map((m) => m.to), ['+33600000001']);
  // the agent answered, but no "lawyer alerted" notice since the alert did not go out
  assert.deepEqual(store.outbound.filter((o) => o.purpose === 'client_reply').map((o) => o.text), [FAKE_INTAKE_FIRST]);
});

test('closed intake: live messaging refuses numbers outside DEMO_ALLOWED_NUMBERS', async () => {
  const { store, messenger, deps } = setup({ MESSAGING_MODE: 'live', DEMO_ALLOWED_NUMBERS: '+33600000009', DEMO_OPEN_INTAKE: 'false' });
  const id = await inbound(store, 'garde à vue');
  const r = await processInbound(deps, id);
  assert.equal(r.status === 'processed' && r.alert, 'failed');
  assert.equal(messenger.sent.length, 0);
  assert.ok(store.outbound.every((o) => o.status === 'failed' && o.error === 'numéro non autorisé'));
  // the client is not told a lawyer was alerted when the alert did not go out
  assert.ok(!store.outbound.some((o) => o.text === CLIENT_NOTICE_ALERTED));
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
