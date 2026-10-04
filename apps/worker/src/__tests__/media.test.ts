import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInbound, defaultUrgencyCriteria } from '../process.js';
import { parseConfig } from '../config.js';
import { inbound, setup } from './helpers.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const AUDIO = 'media:test-audio-1';
const PDF = 'media:test-pdf-2';

test('voice note → transcript stored, then analysed', async () => {
  const { store, ai, deps } = setup({}, { [AUDIO]: { bytes: bytes('Mon fils est en garde à vue depuis ce soir.') } });
  const id = await inbound(store, '', [{ index: 0, url: AUDIO, contentType: 'audio/ogg' }]);
  const r = await processInbound(deps, id);
  const m = await store.getMessage(id);
  assert.equal(m!.kind, 'voice');
  assert.equal(m!.text, 'Mon fils est en garde à vue depuis ce soir.');
  assert.equal(ai.calls.analyze[0]!.trigger.text, 'Mon fils est en garde à vue depuis ce soir.');
  assert.equal(r.status === 'processed' && r.urgency, 'CRITICAL');
  // second run does not transcribe again
  await processInbound(deps, id);
  assert.equal(ai.calls.transcribe, 1);
});

test('PDF → ready document in the analysis context', async () => {
  const { store, ai, deps } = setup({}, { [PDF]: { bytes: bytes('Convocation devant le tribunal correctionnel') } });
  const id = await inbound(store, 'Voici le document reçu.', [{ index: 0, url: PDF, contentType: 'application/pdf' }]);
  await processInbound(deps, id);
  assert.equal(store.documents.length, 1);
  const d = store.documents[0]!;
  assert.equal(d.status, 'ready');
  assert.equal(d.messageId, id);
  assert.equal(d.extractedText, 'Convocation devant le tribunal correctionnel');
  assert.deepEqual(ai.calls.analyze[0]!.documents.map((x) => x.id), [d.id]);
});

test('download failure → failed document, analysis still runs', async () => {
  const { store, deps } = setup(); // downloader knows no URL
  const id = await inbound(store, 'Il a été arrêté, je vous envoie la convocation.', [{ index: 0, url: PDF, contentType: 'application/pdf' }]);
  const r = await processInbound(deps, id);
  assert.equal(store.documents.length, 1);
  assert.equal(store.documents[0]!.status, 'failed');
  assert.equal(store.documents[0]!.extractedText, null);
  assert.equal(store.analyses.length, 1);
  assert.equal(r.status === 'processed' && r.urgency, 'CRITICAL');
});

test('failed voice download → analysis on a placeholder, not on empty text', async () => {
  const { store, ai, deps } = setup();
  const id = await inbound(store, '', [{ index: 0, url: AUDIO, contentType: 'audio/ogg' }]);
  await processInbound(deps, id);
  assert.equal(store.analyses.length, 1);
  assert.ok(ai.calls.analyze[0]!.trigger.text.length > 0);
});

test('legal sources reach the analysis and are redacted by client identity', async () => {
  const { store, ai, legal, deps } = setup();
  const id = await inbound(store, 'garde à vue');
  const r = await processInbound(deps, id);
  assert.deepEqual(ai.calls.analyze[0]!.legalSources!.map((s) => s.reference), ['MOCK']);
  assert.deepEqual(legal.questions[0]!.clientIdentifiers, ['Sarah Miller (fictional)']);
  assert.equal(r.status === 'processed' && r.legalSources.length, 1);
  assert.deepEqual((store.analyses[0]!.result as { legalSources: unknown[] }).legalSources.length, 1);
});

test('urgency criteria file is loaded by default', () => {
  const c = defaultUrgencyCriteria();
  assert.match(c, /CRITICAL/);
  assert.match(c, /garde à vue/);
});

test('liveLegal honours LEGAL_CONTEXT_MODE without network for mock/disabled', async () => {
  const { liveLegal } = await import('../live.js');
  const mock = await liveLegal(parseConfig({ LEGAL_CONTEXT_MODE: 'mock' })).gather('garde à vue', { clientIdentifiers: [] });
  assert.deepEqual(mock.sources.map((s) => s.reference), ['MOCK']);
  const off = await liveLegal(parseConfig({ LEGAL_CONTEXT_MODE: 'disabled' })).gather('garde à vue', { clientIdentifiers: [] });
  assert.deepEqual(off.sources, []);
});
