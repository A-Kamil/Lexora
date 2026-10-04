import type { FastifyInstance } from 'fastify';

import {
  parseKapsoMessage,
  verifyKapsoSignature,
  type KapsoClient,
  type ParsedKapsoMessage,
} from '../whatsapp/kapso.js';
import type {
  IncomingMessageHandler,
  IncomingWhatsAppMessage,
} from '../whatsapp/types.js';
import { maskPhone } from '../whatsapp/phone.js';

type KapsoWebhookOptions = {
  kapsoClient: KapsoClient;
  phoneNumberId: string;
  webhookSecret: string;
  handleIncomingMessage: IncomingMessageHandler;
};

const DUPLICATE_CACHE_SIZE = 1_000;

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function payloadPhoneNumberId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>).phone_number_id;
  return typeof value === 'string' ? value : undefined;
}

export async function registerKapsoWebhook(
  app: FastifyInstance,
  options: KapsoWebhookOptions,
): Promise<void> {
  const processedKeys = new Set<string>();

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  async function safeSend(to: string, body: string): Promise<void> {
    try {
      await options.kapsoClient.sendText(to, body);
    } catch (error) {
      app.log.error({ error, to: maskPhone(to) }, 'Failed to send WhatsApp reply');
    }
  }

  async function processMessage(message: ParsedKapsoMessage): Promise<void> {
    if (message.kind === 'unsupported') {
      await safeSend(
        message.from,
        'Merci d\'envoyer un texte, un message vocal, une photo ou un PDF.',
      );
      return;
    }

    let normalized: IncomingWhatsAppMessage = {
      providerMessageId: message.providerMessageId,
      conversationId: message.conversationId,
      from: message.from,
      kind: message.kind,
      ...(message.text ? { text: message.text } : {}),
    };

    if (message.kind === 'image' || message.kind === 'pdf' || message.kind === 'audio') {
      if (!message.mediaId) {
        await safeSend(message.from, "Nous n'avons pas pu lire ce fichier. Pouvez-vous le renvoyer ?");
        return;
      }

      try {
        const media = await options.kapsoClient.downloadMedia(
          message.mediaId,
          message.mimeType,
          message.filename,
        );
        normalized = { ...normalized, media };
      } catch (error) {
        app.log.error(
          { error, providerMessageId: message.providerMessageId },
          'Failed to download WhatsApp media',
        );
        await safeSend(message.from, "Nous n'avons pas pu lire ce fichier. Pouvez-vous le renvoyer ?");
        return;
      }
    }

    try {
      const response = await options.handleIncomingMessage(normalized);
      if (response?.trim()) await safeSend(message.from, response);
    } catch (error) {
      app.log.error(
        { error, providerMessageId: message.providerMessageId },
        'Backend message handler failed',
      );
      await safeSend(message.from, 'Une erreur technique est survenue. Pouvez-vous renvoyer votre message ?');
    }
  }

  app.post('/webhooks/kapso', async (request, reply) => {
    const rawBody = request.body;
    const signature = headerValue(request.headers['x-webhook-signature']);

    if (
      !Buffer.isBuffer(rawBody) ||
      !verifyKapsoSignature(rawBody, signature, options.webhookSecret)
    ) {
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    if (
      headerValue(request.headers['x-webhook-event']) !==
      'whatsapp.message.received'
    ) {
      return reply.code(200).send({ received: true });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON' });
    }

    if (payloadPhoneNumberId(payload) !== options.phoneNumberId) {
      return reply.code(400).send({ error: 'Unexpected phone number' });
    }

    const message = parseKapsoMessage(payload);
    if (!message) return reply.code(200).send({ received: true });

    const idempotencyKey =
      headerValue(request.headers['x-idempotency-key']) ??
      message.providerMessageId;
    if (processedKeys.has(idempotencyKey)) {
      return reply.code(200).send({ received: true });
    }

    processedKeys.add(idempotencyKey);
    if (processedKeys.size > DUPLICATE_CACHE_SIZE) {
      const oldestKey = processedKeys.values().next().value as string | undefined;
      if (oldestKey) processedKeys.delete(oldestKey);
    }

    reply.code(200).send({ received: true });
    void processMessage(message);
    return reply;
  });
}
