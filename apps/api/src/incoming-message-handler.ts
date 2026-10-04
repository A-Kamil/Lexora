import type { InboundMedia, JobQueue, MemoryStore } from '@lexora/shared/pipeline';
import type { FastifyBaseLogger } from 'fastify';

import type { MediaCache } from './media-cache.js';
import { maskPhone, toE164 } from './whatsapp/phone.js';
import type { IncomingMessageHandler } from './whatsapp/types.js';

/**
 * Kapso message -> case store -> `process-inbound` job. Unknown numbers get their own case (open intake). Returns no immediate reply: the worker answers
 * the client once the analysis is done (and alerts the lawyer when urgent). Logs carry ids and masked
 * numbers only, never message content.
 */
/** Spam guard for a public number in a room full of people: Mistral is called once per message. */
export const MAX_INTAKE_CASES = 40;
export const MAX_MESSAGES_PER_CASE = 25;

export function createIncomingMessageHandler(deps: {
  store: MemoryStore;
  openIntake: boolean;
  queue: JobQueue;
  media: MediaCache;
  log: FastifyBaseLogger;
}): IncomingMessageHandler {
  return async (message) => {
    const phone = toE164(message.from);
    const fields = { providerMessageId: message.providerMessageId, from: maskPhone(phone), kind: message.kind };

    // The lawyer sits on every intake case, so resolveParticipant would call them ambiguous: check first.
    if (deps.store.people.some((p) => p.role === 'lawyer' && p.phoneE164 === phone)) {
      deps.log.info(fields, 'message from the lawyer: not analysed');
      return undefined;
    }
    let who = await deps.store.resolveParticipant(phone);
    if (who.kind === 'absent' && deps.openIntake) {
      if (deps.store.cases.length >= MAX_INTAKE_CASES) {
        deps.log.warn(fields, 'intake case limit reached: ignored');
        return 'Le cabinet ne peut pas ouvrir de nouveau dossier pour le moment. Merci de rappeler plus tard.';
      }
      const opened = deps.store.openIntakeCase(phone);
      who = { kind: 'found', person: opened.person, caseId: opened.caseId };
      deps.log.info({ ...fields, caseId: opened.caseId }, 'new contact: intake case opened');
    }
    if (who.kind !== 'found') {
      deps.log.warn({ ...fields, resolve: who.kind }, 'sender is not a participant of a case: ignored');
      return undefined;
    }
    if (who.person.role !== 'client') {
      deps.log.info(fields, 'message from the lawyer: not analysed');
      return undefined;
    }

    const caseId = who.caseId;
    if (deps.store.messages.filter((m) => m.caseId === caseId && m.direction === 'inbound').length >= MAX_MESSAGES_PER_CASE) {
      deps.log.warn({ ...fields, caseId }, 'message limit reached for this case: ignored');
      return undefined;
    }

    const media: InboundMedia[] = [];
    if (message.media) {
      const ref = `kapso:${message.providerMessageId}:0`;
      deps.media.put(ref, message.media);
      media.push({ index: 0, url: ref, contentType: message.media.mimeType });
    }

    const { message: stored, created } = await deps.store.saveInboundMessage({
      caseId: who.caseId,
      personId: who.person.id,
      provider: 'kapso',
      providerMessageId: message.providerMessageId,
      text: message.text ?? '',
      media,
      receivedAt: new Date().toISOString(),
    });
    if (created) await deps.queue.enqueue('process-inbound', { messageId: stored.id });
    deps.log.info({ ...fields, messageId: stored.id, created, media: media.length }, 'inbound stored and queued');
    return undefined;
  };
}
