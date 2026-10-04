import Fastify from 'fastify';
import { parseApiEnv } from '@lexora/shared';

const config = parseApiEnv(process.env);
const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ port: config.port, host: '0.0.0.0' });
