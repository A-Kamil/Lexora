import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../demo-page.js';
import { inbound, post, setup } from './support/helpers.js';

const XSS = '<script>alert("x")</script>';

test('demo: route absent unless APP_MODE=demo', async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: 'GET', url: '/demo' })).statusCode, 404);
  await app.close();
});

test('demo: empty case renders, refreshes every 3 s, no external resources', async () => {
  const { app } = setup({ APP_MODE: 'demo' });
  const res = await app.inject({ method: 'GET', url: '/demo' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /^text\/html/);
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
  assert.match(res.body, /<meta http-equiv="refresh" content="3">/);
  assert.match(res.body, /Fictional criminal case/);
  assert.match(res.body, /Aucun message reçu/);
  assert.match(res.body, /Pas encore d’analyse/);
  assert.doesNotMatch(res.body, /https?:\/\/|<script/);
  await app.close();
});

test('demo: shows messages, documents, last analysis and outbound with status', async () => {
  const { app, store } = setup({ APP_MODE: 'demo' });
  assert.equal((await post(app, inbound({ Body: 'My brother is in police custody (fictional)' }))).statusCode, 200);
  const voice = await store.saveInboundMessage({ caseId: 'c-1', personId: 'p-client', provider: 'twilio', providerMessageId: 'SM2', text: '', media: [], receivedAt: new Date().toISOString() });
  await store.setMessageTranscript(voice.message.id, 'Transcribed fictional voice note');
  await store.saveDocument({ caseId: 'c-1', messageId: voice.message.id, mimeType: 'application/pdf', status: 'ready', extractedText: 'Fictional summons to appear', documentType: 'summons' });
  await store.saveAnalysis({ caseId: 'c-1', conversationId: 'conv-c-1', triggerKey: 'old', status: 'ok', model: 'm', result: { urgency: 'LOW', urgencyReason: 'Old analysis' } });
  await store.saveAnalysis({ caseId: 'c-1', conversationId: 'conv-c-1', triggerKey: 'new', status: 'ok', model: 'mistral-fake', result: {
    urgency: 'CRITICAL', urgencyReason: 'Person in custody now (fictional)', missingInformation: ['Police station'], recommendedActions: ['Call the station'],
  } });
  const alert = await store.saveOutbound({ caseId: 'c-1', personId: 'p-lawyer', text: 'CRITICAL alert (fictional)', purpose: 'lawyer_alert' });
  await store.markOutbound(alert.messageId, 'sent', 'SM3');
  const ack = await store.saveOutbound({ caseId: 'c-1', personId: 'p-client', text: 'We received your message (fictional)', purpose: 'client_reply' });
  await store.markOutbound(ack.messageId, 'failed', undefined, 'not delivered');

  const body = (await app.inject({ method: 'GET', url: '/demo' })).body;
  for (const expected of [
    'My brother is in police custody (fictional)', 'Transcribed fictional voice note', 'Message vocal (transcription)',
    'summons', 'Fictional summons to appear',
    '<div class="urgency critical">CRITICAL</div>', 'Person in custody now (fictional)', 'Police station', 'Call the station', 'mistral-fake',
    'Alerte à l’avocat', 'John Smith (fictional)', 'CRITICAL alert (fictional)', 'envoyé',
    'Accusé au client', 'We received your message (fictional)', 'échec', 'not delivered',
  ]) assert.ok(body.includes(expected), `missing: ${expected}`);
  assert.ok(!body.includes('Old analysis'), 'only the last analysis is shown');
  assert.ok(!body.includes('+33600000001'), 'no phone numbers on screen');
  await app.close();
});

test('demo: nested { analysis } result and fallback are rendered', async () => {
  const { app, store } = setup({ APP_MODE: 'demo' });
  await store.saveAnalysis({ caseId: 'c-1', conversationId: 'conv-c-1', triggerKey: 'k', status: 'fallback', model: 'none', result: { analysis: { urgency: 'HIGH', urgencyReason: 'Automated assessment failed' } } });
  const body = (await app.inject({ method: 'GET', url: '/demo' })).body;
  assert.ok(body.includes('<div class="urgency high">HIGH</div>'));
  assert.ok(body.includes('Analyse de secours'));
  await app.close();
});

test('demo: every stored text is escaped', async () => {
  const { app, store } = setup({ APP_MODE: 'demo' });
  assert.equal((await post(app, inbound({ Body: XSS }))).statusCode, 200);
  const m = store.messages[0]!;
  await store.saveDocument({ caseId: 'c-1', messageId: m.id, mimeType: XSS, status: 'ready', extractedText: XSS, documentType: XSS });
  await store.saveAnalysis({ caseId: 'c-1', conversationId: 'conv-c-1', triggerKey: 'k', status: 'ok', model: XSS, result: { urgency: XSS, urgencyReason: XSS, missingInformation: [XSS], recommendedActions: [XSS] } });
  await store.saveOutbound({ caseId: 'c-1', personId: 'p-lawyer', text: XSS, purpose: 'lawyer_alert' });
  store.people[0]!.displayName = XSS;
  store.cases[0]!.title = XSS;

  const body = (await app.inject({ method: 'GET', url: '/demo' })).body;
  assert.ok(!body.includes('<script'), 'raw <script> must never reach the page');
  assert.ok(body.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  await app.close();
});

test('escapeHtml escapes the five HTML characters', () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
});
