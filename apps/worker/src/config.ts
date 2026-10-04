import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const schema = z.object({
  AI_MODE: z.enum(['fake', 'live']).default('fake'),
  MESSAGING_MODE: z.enum(['fake', 'live']).default('fake'),
  LEGAL_CONTEXT_MODE: z.enum(['disabled', 'mock', 'direct']).default('mock'),
  /** Comma-separated E.164 numbers; live sends to any other number are refused. Empty = nothing is sent. */
  DEMO_ALLOWED_NUMBERS: list,
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_ANALYSIS_MODEL: z.string().optional(),
  MISTRAL_OCR_MODEL: z.string().optional(),
  MISTRAL_TRANSCRIPTION_MODEL: z.string().optional(),
  PISTE_CLIENT_ID: z.string().optional(),
  PISTE_CLIENT_SECRET: z.string().optional(),
  PISTE_ENV: z.enum(['prod', 'sandbox']).default('prod'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_NUMBER: z.string().optional(),
});

export type WorkerConfig = ReturnType<typeof parseConfig>;

/** Everything defaults to fake/mock: a live mode must be asked for explicitly. */
export function parseConfig(env: Record<string, string | undefined>) {
  const v = schema.parse(env);
  return {
    aiMode: v.AI_MODE,
    messagingMode: v.MESSAGING_MODE,
    legalContextMode: v.LEGAL_CONTEXT_MODE,
    allowedNumbers: v.DEMO_ALLOWED_NUMBERS,
    mistral: {
      apiKey: v.MISTRAL_API_KEY,
      models: { analysis: v.MISTRAL_ANALYSIS_MODEL, ocr: v.MISTRAL_OCR_MODEL, transcription: v.MISTRAL_TRANSCRIPTION_MODEL },
    },
    piste: v.PISTE_CLIENT_ID && v.PISTE_CLIENT_SECRET
      ? { clientId: v.PISTE_CLIENT_ID, clientSecret: v.PISTE_CLIENT_SECRET, env: v.PISTE_ENV }
      : null,
    twilio: { accountSid: v.TWILIO_ACCOUNT_SID, authToken: v.TWILIO_AUTH_TOKEN, whatsappNumber: v.TWILIO_WHATSAPP_NUMBER },
  };
}
