import type { IncomingMessageHandler } from './whatsapp/types.js';

export const handleIncomingMessage: IncomingMessageHandler = async (message) => {
  console.info('Incoming WhatsApp message', {
    providerMessageId: message.providerMessageId,
    conversationId: message.conversationId,
    from: message.from,
    kind: message.kind,
    hasMedia: Boolean(message.media),
  });

  return 'Thanks, we received your message.';
};
