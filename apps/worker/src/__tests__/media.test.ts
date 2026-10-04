import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInbound, defaultUrgencyCriteria } from '../process.js';
import { twilioDownloader } from '../live.js';
import { parseConfig } from '../config.js';
import { inbound, setup } from './helpers.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const AUDIO = 'https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages/MMfake/Media/ME1';
const PDF = 'https://api.twilio.com/2010-04-01/Accounts/ACfake/Messages/MMfake/Media/ME2';

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

test('twilio downloader: only https://api.twilio.com, Basic auth, size cap', async () => {
  const cfg = parseConfig({ TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tok' });
  let auth = '';
  const ok = twilioDownloader(cfg, (async (_u: URL, init: RequestInit) => {
    auth = (init.headers as Record<string, string>).authorization!;
    return new Response(bytes('abc'), { headers: { 'content-type': 'audio/ogg' } });
  }) as typeof fetch);
  const r = await ok.download(AUDIO);
  assert.equal(new TextDecoder().decode(r.bytes), 'abc');
  assert.equal(auth, 'Basic ' + Buffer.from('ACfake:tok').toString('base64'));
  await assert.rejects(ok.download('https://evil.example/x'), /not allowed/);
  await assert.rejects(ok.download('http://api.twilio.com/x'), /not allowed/);
  const big = twilioDownloader(cfg, (async () => new Response(new Uint8Array(11 * 1024 * 1024))) as typeof fetch);
  await assert.rejects(big.download(AUDIO), /too large/);
});
