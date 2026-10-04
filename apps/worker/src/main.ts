import { randomUUID } from 'node:crypto';
import { MemoryStore } from '@lexora/shared/pipeline';
import { parseConfig } from './config.js';
import { createDeps } from './deps.js';
import { processInbound } from './process.js';

/**
 * `node dist/main.js demo "texte"`: the pipeline without WhatsApp, on fictional in-memory data.
 * Without arguments: the queue consumer is not wired yet (pg-boss comes with packages/db).
 */
async function demo(text: string) {
  const config = parseConfig(process.env);
  const store = MemoryStore.seeded();
  // Fictional client matching the demo message, so the legal lookups are redacted on that name.
  const client = store.people.find((p) => p.id === 'p-client')!;
  client.displayName = 'Martin Exemple (fictional)';
  store.cases[0]!.title = 'Affaire pénale (fictional)';
  store.cases[0]!.language = 'fr';

  const { message } = await store.saveInboundMessage({
    caseId: 'c-1', personId: client.id, provider: 'test', providerMessageId: `SM-demo-${randomUUID()}`,
    text, media: [], receivedAt: new Date().toISOString(),
  });

  console.log(`modes: AI=${config.aiMode} MESSAGING=${config.messagingMode} LEGAL=${config.legalContextMode}`);
  const result = await processInbound(createDeps(config, store), message.id);

  const saved = store.analyses[0];
  console.log('\n=== Analyse ===');
  console.log(JSON.stringify(saved ? { status: saved.status, model: saved.model, ...(saved.result as object) } : result, null, 2));
  console.log('\n=== Envois ===');
  for (const o of store.outbound) {
    console.log(`--- ${o.purpose} → ${o.personId} [${o.status}${o.error ? ` : ${o.error}` : ''}]\n${o.text}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'demo') {
  const text = rest.join(' ').trim();
  if (!text) {
    console.error('usage: pnpm --filter @lexora/worker demo "texte du message"');
    process.exit(2);
  }
  await demo(text);
} else {
  parseConfig(process.env);
  console.error('Queue consumer not wired yet (waiting for pg-boss in packages/db). Use: pnpm --filter @lexora/worker demo "texte du message"');
  process.exit(1);
}
