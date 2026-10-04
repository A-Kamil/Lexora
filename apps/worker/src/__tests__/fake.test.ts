import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAi, FakeMessenger, fakeTriage } from '../fake.js';
import { parseConfig } from '../config.js';

test('fake AI is deterministic on keywords', () => {
  assert.equal(fakeTriage('Mon fils est en garde à vue').urgency, 'CRITICAL');
  assert.equal(fakeTriage('Mon fils est en GARDE A VUE').urgency, 'CRITICAL');
  assert.equal(fakeTriage('He was arrested tonight').urgency, 'CRITICAL');
  assert.equal(fakeTriage('Il a été arrêté').urgency, 'CRITICAL');
  assert.equal(fakeTriage('In police custody').urgency, 'CRITICAL');
  assert.equal(fakeTriage("J'ai reçu une convocation").urgency, 'HIGH');
  assert.equal(fakeTriage('The hearing is on Monday').urgency, 'HIGH');
  assert.equal(fakeTriage("L'audience est lundi").urgency, 'HIGH');
  assert.equal(fakeTriage('Quels sont vos horaires ?').urgency, 'LOW');
});

test('fake AI returns a schema-shaped analysis', async () => {
  const ai = new FakeAi();
  const msg = { id: 'm1', role: 'client' as const, text: 'garde à vue', at: '2026-10-04T22:00:00Z' };
  const r = await ai.analyze({ caseTitle: 't', jurisdiction: 'FR', language: 'fr', priorMessages: [msg], trigger: msg, documents: [] });
  assert.equal(r.analysis.urgency, 'CRITICAL');
  assert.equal(r.analysis.requiresLawyer, true);
  assert.deepEqual(r.includedMessageIds, ['m1']);
  assert.deepEqual(await ai.analyze({ caseTitle: 't', jurisdiction: 'FR', language: 'fr', priorMessages: [msg], trigger: msg, documents: [] }), r);
});

test('fake messenger only simulates', async () => {
  const m = new FakeMessenger();
  assert.deepEqual(await m.send('+33600000002', 'x'), { status: 'simulated' });
  assert.equal(m.sent.length, 1);
});

test('config defaults to fake/mock and closed allowlist', () => {
  const c = parseConfig({});
  assert.equal(c.aiMode, 'fake');
  assert.equal(c.messagingMode, 'fake');
  assert.equal(c.legalContextMode, 'mock');
  assert.deepEqual(c.allowedNumbers, []);
  assert.deepEqual(parseConfig({ DEMO_ALLOWED_NUMBERS: ' +33600000002, +33600000003 ' }).allowedNumbers, ['+33600000002', '+33600000003']);
  assert.throws(() => parseConfig({ AI_MODE: 'real' }));
});
