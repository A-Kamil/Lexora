import { z } from 'zod';

const E164 = /^\+[1-9]\d{7,14}$/;

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_MODE: z.enum(['demo', 'test']).default('demo'),
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  // Comma-separated E.164 numbers; empty means every sender is refused.
  DEMO_ALLOWED_NUMBERS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((n) => n.trim()).filter((n) => n.length > 0))
    .pipe(z.array(z.string().regex(E164, 'DEMO_ALLOWED_NUMBERS must contain E.164 numbers'))),
  STORE_MODE: z.enum(['memory', 'db']).default('memory'),
});

export interface ApiConfig {
  port: number;
  appMode: 'demo' | 'test';
  publicBaseUrl: string;
  twilioAuthToken: string;
  twilioAccountSid: string | undefined;
  allowedNumbers: ReadonlySet<string>;
  storeMode: 'memory' | 'db';
}

export function parseConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const v = envSchema.parse(env);
  return {
    port: v.PORT,
    appMode: v.APP_MODE,
    publicBaseUrl: v.PUBLIC_BASE_URL,
    twilioAuthToken: v.TWILIO_AUTH_TOKEN,
    twilioAccountSid: v.TWILIO_ACCOUNT_SID,
    allowedNumbers: new Set(v.DEMO_ALLOWED_NUMBERS),
    storeMode: v.STORE_MODE,
  };
}
