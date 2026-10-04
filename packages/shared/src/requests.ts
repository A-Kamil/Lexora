import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './domain.js';

/**
 * Request-shaped contracts.
 *
 * Only what this milestone actually uses lives here. The WhatsApp `InboundMessage`
 * normalization (Task 5) and the versioned voice API contracts (Task 8) are added by
 * their own tasks.
 */

export const MESSAGE_PAGE_DEFAULT_LIMIT = 50;
export const MESSAGE_PAGE_MAX_LIMIT = 100;

/**
 * Keyset pagination position: the last row of the previous page.
 *
 * Keyset rather than offset, because messages are appended continuously — an offset
 * page would skip or repeat rows as the conversation grows. `(createdAt, id)` matches
 * the chronology index and is total, so the order is stable.
 */
export const MessageCursorSchema = z.strictObject({
  createdAt: IsoDateTimeSchema,
  id: UuidSchema,
});
export type MessageCursor = z.infer<typeof MessageCursorSchema>;

export const MessagePageRequestSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .positive()
    .max(MESSAGE_PAGE_MAX_LIMIT)
    .default(MESSAGE_PAGE_DEFAULT_LIMIT),
  cursor: z.string().min(1).nullable().default(null),
});
export type MessagePageRequest = z.infer<typeof MessagePageRequestSchema>;

/** Encode a cursor as an opaque token. Carries no secret, so base64url is enough. */
export function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(MessageCursorSchema.parse(cursor)), 'utf8').toString(
    'base64url',
  );
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

/** Decode an opaque cursor token. Throws {@link InvalidCursorError} on anything malformed. */
export function decodeMessageCursor(token: string): MessageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const result = MessageCursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidCursorError();
  }
  return result.data;
}
