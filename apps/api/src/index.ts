import Fastify from 'fastify';
import { parseApiEnv } from '@lexora/shared';

import { handleIncomingMessage } from './incoming-message-handler.js';
import { registerKapsoWebhook } from './routes/kapso-webhook.js';
import { createKapsoClient } from './whatsapp/kapso.js';

const config = parseApiEnv(process.env);
const app = Fastify({ logger: true });
const kapsoClient = createKapsoClient({
  apiKey: config.kapsoApiKey,
  phoneNumberId: config.kapsoPhoneNumberId,
});

app.get('/health', async () => ({ status: 'ok' }));
await app.register(registerKapsoWebhook, {
  kapsoClient,
  phoneNumberId: config.kapsoPhoneNumberId,
  webhookSecret: config.kapsoWebhookSecret,
  handleIncomingMessage,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ port: config.port, host: '0.0.0.0' });
