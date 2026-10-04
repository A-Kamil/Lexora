import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MISTRAL_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_NUMBER: z.string().optional(),
});

export function parseApiEnv(env: NodeJS.ProcessEnv) {
  const value = envSchema.parse(env);
  return { databaseUrl: value.DATABASE_URL, port: value.PORT };
}

export function parseWorkerEnv(env: NodeJS.ProcessEnv) {
  return envSchema.parse(env);
}
