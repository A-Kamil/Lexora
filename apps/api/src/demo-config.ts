import { z } from 'zod';

const E164 = /^\+[1-9]\d{7,14}$/;

const schema = z.object({
  // Comma-separated E.164 numbers; live WhatsApp sends to any other number are refused by the worker.
  DEMO_ALLOWED_NUMBERS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0),
    )
    .pipe(z.array(z.string().regex(E164, 'DEMO_ALLOWED_NUMBERS must contain E.164 numbers'))),
  // JSON file the case store is saved to (relative to apps/api). 'off' keeps everything in memory only.
  LEXORA_STORE_FILE: z.string().default('data/lexora-store.json'),
});

export interface DemoConfig {
  allowedNumbers: ReadonlySet<string>;
  storeFile: string | null;
}

export function parseDemoConfig(env: NodeJS.ProcessEnv): DemoConfig {
  const v = schema.parse(env);
  return {
    allowedNumbers: new Set(v.DEMO_ALLOWED_NUMBERS),
    storeFile: v.LEXORA_STORE_FILE === 'off' ? null : v.LEXORA_STORE_FILE,
  };
}
