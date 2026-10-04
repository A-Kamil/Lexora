import { createHmac, timingSafeEqual } from 'node:crypto';

import type { DownloadedMedia } from './types.js';

const API_BASE = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const SUPPORTED_MEDIA_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

type JsonRecord = Record<string, unknown>;

export type ParsedKapsoMessage = {
  providerMessageId: string;
  conversationId: string;
  from: string;
  kind: 'text' | 'image' | 'pdf' | 'unsupported';
  text?: string;
  mediaId?: string;
  mimeType?: string;
  filename?: string;
};

export type KapsoClient = {
  downloadMedia(
    mediaId: string,
    expectedMimeType?: string,
    filename?: string,
  ): Promise<DownloadedMedia>;
  sendText(to: string, body: string): Promise<string>;
};

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function verifyKapsoSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  return (
    expectedBuffer.length === signatureBuffer.length &&
    timingSafeEqual(expectedBuffer, signatureBuffer)
  );
}

export function parseKapsoMessage(payload: unknown): ParsedKapsoMessage | null {
  const root = asRecord(payload);
  const message = asRecord(root?.message);
  const conversation = asRecord(root?.conversation);
  const providerMessageId = asString(message?.id);
  const conversationId = asString(conversation?.id);
  const from = asString(message?.from) ?? asString(conversation?.phone_number);
  const type = asString(message?.type);

  if (!message || !conversation || !providerMessageId || !conversationId || !from || !type) {
    return null;
  }

  const base = { providerMessageId, conversationId, from };

  if (type === 'text') {
    const text = asString(asRecord(message.text)?.body);
    return text ? { ...base, kind: 'text', text } : null;
  }

  const kapsoMedia = asRecord(asRecord(message.kapso)?.media_data);

  if (type === 'image') {
    const image = asRecord(message.image);
    const mediaId = asString(image?.id);
    const text = asString(image?.caption);
    const mimeType = asString(image?.mime_type) ?? asString(kapsoMedia?.content_type);
    const filename = asString(kapsoMedia?.filename);
    if (!mediaId) return null;

    return {
      ...base,
      kind: 'image',
      mediaId,
      ...(text ? { text } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(filename ? { filename } : {}),
    };
  }

  if (type === 'document') {
    const document = asRecord(message.document);
    const mediaId = asString(document?.id);
    const mimeType = asString(document?.mime_type) ?? asString(kapsoMedia?.content_type);
    const text = asString(document?.caption);
    const filename = asString(document?.filename) ?? asString(kapsoMedia?.filename);

    if (!mediaId) return null;
    if (mimeType !== 'application/pdf') return { ...base, kind: 'unsupported' };

    return {
      ...base,
      kind: 'pdf',
      mediaId,
      mimeType,
      ...(text ? { text } : {}),
      ...(filename ? { filename } : {}),
    };
  }

  return { ...base, kind: 'unsupported' };
}

export function createKapsoClient(
  config: { apiKey: string; phoneNumberId: string },
  fetchImpl: typeof fetch = fetch,
): KapsoClient {
  const apiHeaders = { 'X-API-Key': config.apiKey };

  return {
    async downloadMedia(mediaId, expectedMimeType, filename) {
      const metadataUrl = new URL(`${API_BASE}/${encodeURIComponent(mediaId)}`);
      metadataUrl.searchParams.set('phone_number_id', config.phoneNumberId);

      const metadataResponse = await fetchImpl(metadataUrl, {
        headers: apiHeaders,
      });
      if (!metadataResponse.ok) {
        throw new Error(`Kapso media lookup failed (${metadataResponse.status})`);
      }

      const metadata = asRecord(await metadataResponse.json());
      const mimeType = asString(metadata?.mime_type);
      const downloadUrl = asString(metadata?.download_url);
      const reportedSize = Number(asString(metadata?.file_size));

      if (!mimeType || !SUPPORTED_MEDIA_TYPES.has(mimeType)) {
        throw new Error('Kapso returned an unsupported media type');
      }
      if (expectedMimeType && expectedMimeType !== mimeType) {
        throw new Error('Kapso media type does not match the webhook');
      }
      if (!downloadUrl) throw new Error('Kapso did not return a media URL');
      if (Number.isFinite(reportedSize) && reportedSize > MAX_MEDIA_BYTES) {
        throw new Error('WhatsApp media exceeds the 10 MB limit');
      }

      const fileResponse = await fetchImpl(downloadUrl);
      if (!fileResponse.ok) {
        throw new Error(`Kapso media download failed (${fileResponse.status})`);
      }

      const bytes = Buffer.from(await fileResponse.arrayBuffer());
      if (bytes.byteLength > MAX_MEDIA_BYTES) {
        throw new Error('WhatsApp media exceeds the 10 MB limit');
      }

      return { bytes, mimeType, ...(filename ? { filename } : {}) };
    },

    async sendText(to, body) {
      const response = await fetchImpl(
        `${API_BASE}/${encodeURIComponent(config.phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            ...apiHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body },
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Kapso message send failed (${response.status})`);
      }

      const payload = asRecord(await response.json());
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const messageId = asString(asRecord(messages[0])?.id);
      if (!messageId) throw new Error('Kapso did not return a message ID');

      return messageId;
    },
  };
}
