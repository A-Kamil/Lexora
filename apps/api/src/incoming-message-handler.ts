import type { IncomingMessageHandler } from './whatsapp/types.js';

export type GenerateReply = (message: string) => Promise<string>;

export function createIncomingMessageHandler(generateReply: GenerateReply): IncomingMessageHandler {
  return async (message) => {
    if (message.kind !== 'text' || !message.text?.trim()) return undefined;
    return generateReply(message.text);
  };
}
