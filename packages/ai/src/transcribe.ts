import type { Mistral } from '@mistralai/mistralai';

/** Voxtral transcription of a WhatsApp voice note (audio/ogg) or a call recording. */
export async function transcribeVoice(
  client: Mistral,
  input: { bytes: Uint8Array; fileName: string; language?: string },
  model: string,
): Promise<{ text: string; language: string | null }> {
  const res = await client.audio.transcriptions.complete(
    { model, file: { fileName: input.fileName, content: input.bytes }, language: input.language ?? 'fr' },
    { timeoutMs: 120_000 },
  );
  return { text: res.text.trim(), language: res.language };
}
