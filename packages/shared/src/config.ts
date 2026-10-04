import { z } from 'zod';

const baseEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MISTRAL_API_KEY: z.string().optional(),
});

const apiEnvSchema = baseEnvSchema.extend({
  KAPSO_API_KEY: z.string().min(1),
  KAPSO_PHONE_NUMBER_ID: z.string().min(1),
  KAPSO_WEBHOOK_SECRET: z.string().min(1),
});

export function parseApiEnv(env: NodeJS.ProcessEnv) {
  const value = apiEnvSchema.parse(env);
  return {
    databaseUrl: value.DATABASE_URL,
    port: value.PORT,
    kapsoApiKey: value.KAPSO_API_KEY,
    kapsoPhoneNumberId: value.KAPSO_PHONE_NUMBER_ID,
    kapsoWebhookSecret: value.KAPSO_WEBHOOK_SECRET,
  };
}

export function parseWorkerEnv(env: NodeJS.ProcessEnv) {
  return baseEnvSchema.parse(env);
}
