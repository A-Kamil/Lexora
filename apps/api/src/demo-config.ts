import { z } from 'zod';

const E164 = /^\+[1-9]\d{7,14}$/;

const schema = z.object({
  // Comma-separated E.164 numbers; live WhatsApp sends to any other number are refused by the worker.
  DEMO_ALLOWED_NUMBERS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((n) => n.trim()).filter((n) => n.length > 0))
    .pipe(z.array(z.string().regex(E164, 'DEMO_ALLOWED_NUMBERS must contain E.164 numbers'))),
  // Real demo phones replacing the fictional seeded client and lawyer (memory store).
  DEMO_CLIENT_PHONE: z.string().regex(E164, 'DEMO_CLIENT_PHONE must be E.164').optional(),
  DEMO_LAWYER_PHONE: z.string().regex(E164, 'DEMO_LAWYER_PHONE must be E.164').optional(),
});

export interface DemoConfig {
  allowedNumbers: ReadonlySet<string>;
  demoClientPhone: string | undefined;
  demoLawyerPhone: string | undefined;
}

export function parseDemoConfig(env: NodeJS.ProcessEnv): DemoConfig {
  const v = schema.parse(env);
  return {
    allowedNumbers: new Set(v.DEMO_ALLOWED_NUMBERS),
    demoClientPhone: v.DEMO_CLIENT_PHONE,
    demoLawyerPhone: v.DEMO_LAWYER_PHONE,
  };
}
