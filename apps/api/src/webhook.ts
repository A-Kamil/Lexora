import type { FastifyInstance, FastifyReply } from 'fastify';
import formbody from '@fastify/formbody';
import twilio from 'twilio';
import { z } from 'zod';
import type { AppDeps } from './app.js';

export const WEBHOOK_PATH = '/webhooks/twilio';
const BODY_LIMIT = 256 * 1024;
const EMPTY_TWIML = '<Response/>';

const fieldsSchema = z.object({
  From: z.string().regex(/^whatsapp:\+[1-9]\d{7,14}$/),
  MessageSid: z.string().min(1).max(64),
  AccountSid: z.string().min(1).max(64),
  NumMedia: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().max(10)),
  Body: z.string().default(''),
});

/** `+33600000001` -> `+336******01`: never log a full number. */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '*'.repeat(e164.length);
  return e164.slice(0, 4) + '*'.repeat(e164.length - 6) + e164.slice(-2);
}

function twiml(reply: FastifyReply) {
  return reply.code(200).type('application/xml').send(EMPTY_TWIML);
}

export async function webhookRoutes(app: FastifyInstance, { config, store }: AppDeps) {
  await app.register(formbody, { bodyLimit: BODY_LIMIT });
  const signedUrl = config.publicBaseUrl + WEBHOOK_PATH;

  app.post(WEBHOOK_PATH, { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const params: Record<string, unknown> =
      request.body !== null && typeof request.body === 'object' ? (request.body as Record<string, unknown>) : {};

    // 1. Signature first: nothing is read or logged from an unsigned request.
    const signature = request.headers['x-twilio-signature'];
    if (typeof signature !== 'string' || !twilio.validateRequest(config.twilioAuthToken, signature, signedUrl, params)) {
      request.log.warn({ reason: 'invalid_signature' }, 'twilio webhook rejected');
      return reply.code(403).send({ error: 'invalid signature' });
    }

    // 2. Required fields.
    const parsed = fieldsSchema.safeParse(params);
    if (!parsed.success || (config.twilioAccountSid !== undefined && parsed.data.AccountSid !== config.twilioAccountSid)) {
      request.log.warn({ reason: 'malformed' }, 'twilio webhook rejected');
      return reply.code(400).send({ error: 'malformed request' });
    }

    const fields = parsed.data;
    const phone = fields.From.slice('whatsapp:'.length);
    const log = request.log.child({ messageSid: fields.MessageSid, from: maskPhone(phone) });

    // 3. Demo allowlist (empty list refuses everyone).
    if (!config.allowedNumbers.has(phone)) {
      log.info({ reason: 'not_allowlisted' }, 'inbound ignored');
      return twiml(reply);
    }

    // 4. Who is writing?
    let resolved;
    try {
      resolved = await store.resolveParticipant(phone);
    } catch (err) {
      log.error({ err }, 'store unavailable');
      return reply.code(503).send({ error: 'store unavailable' });
    }
    if (resolved.kind !== 'found') {
      log.info({ reason: resolved.kind }, 'inbound ignored');
      return twiml(reply);
    }
    if (resolved.person.role === 'lawyer') {
      log.info({ reason: 'sender_is_lawyer' }, 'inbound ignored');
      return twiml(reply);
    }

    return twiml(reply);
  });
}
