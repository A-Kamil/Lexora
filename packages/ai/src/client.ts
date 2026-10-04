import { Mistral } from '@mistralai/mistralai';

/** Live Mistral client. Callers decide fake vs live (AI_MODE) before reaching this. */
export function mistralClient(apiKey: string | undefined): Mistral {
  if (!apiKey) throw new Error('MISTRAL_API_KEY is required in live AI mode');
  return new Mistral({ apiKey });
}

export const DEFAULT_MODELS = {
  analysis: 'mistral-large-latest',
  ocr: 'mistral-ocr-latest',
  transcription: 'voxtral-mini-latest',
} as const;

/** First text block of a chat completion, whatever the SDK's content shape. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}
