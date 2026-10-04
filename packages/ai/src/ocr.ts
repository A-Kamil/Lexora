import { z } from 'zod';
import type { Mistral } from '@mistralai/mistralai';
import { OCR_METADATA_SYSTEM, wrapAsData } from './prompts.js';
import { textOf } from './client.js';

export const DocumentMetadataSchema = z.object({
  documentType: z.string().max(100),
  summary: z.string().max(1500),
  dateMentions: z
    .array(z.object({ text: z.string().max(200), isoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), sourcePage: z.number().int().nullable() }))
    .max(30),
});
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;

export const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** Mistral OCR (PDF, DOCX, photos) then classification. Dates stay unverified mentions. */
export async function extractDocument(
  client: Mistral,
  input: { bytes: Uint8Array; mimeType: string; fileName?: string },
  models: { ocr: string; analysis: string },
): Promise<{ text: string; pages: number; metadata: DocumentMetadata }> {
  if (!SUPPORTED_MIME.has(input.mimeType)) throw new Error(`unsupported media type: ${input.mimeType}`);
  const dataUrl = `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString('base64')}`;
  const ocr = await client.ocr.process(
    {
      model: models.ocr,
      document: input.mimeType.startsWith('image/')
        ? { type: 'image_url', imageUrl: dataUrl }
        : { type: 'document_url', documentUrl: dataUrl, documentName: input.fileName ?? null },
    },
    { timeoutMs: 60_000 },
  );
  const pages = ocr.pages ?? [];
  const text = pages.map((p) => `--- page ${p.index} ---\n${p.markdown}`).join('\n\n').trim();
  const res = await client.chat.complete(
    {
      model: models.analysis,
      temperature: 0,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: OCR_METADATA_SYSTEM },
        { role: 'user', content: wrapAsData('DOCUMENT', text.slice(0, 20_000)) },
      ],
    },
    { timeoutMs: 45_000 },
  );
  const parsed = DocumentMetadataSchema.safeParse(JSON.parse(textOf(res.choices?.[0]?.message?.content) || '{}'));
  const metadata: DocumentMetadata = parsed.success ? parsed.data : { documentType: 'other', summary: '', dateMentions: [] };
  return { text, pages: pages.length, metadata };
}
