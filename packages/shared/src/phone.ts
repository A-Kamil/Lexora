/**
 * Phone handling.
 *
 * Phone numbers are a *routing* key, never an authentication factor. Normalization
 * therefore refuses to guess: a number without an explicit country code is rejected
 * rather than interpreted against some assumed region.
 *
 * Errors never carry the digits, so a rejection can be logged safely.
 */

/** Channel prefixes providers put in front of the number (Twilio sends `whatsapp:+33…`). */
const CHANNEL_PREFIX = /^(?:whatsapp|sms|tel|voice|messenger|channel):/i;

/** Visual separators that carry no information. */
const SEPARATORS = /[\s\u00a0\u202f\u2007().\-/]/g;

/** E.164: `+`, a country code that cannot start with 0, 7 to 15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/;

export type PhoneRejectionReason =
  | 'empty'
  | 'missing_country_code'
  | 'invalid_characters'
  | 'invalid_format';

export class PhoneNormalizationError extends Error {
  readonly reason: PhoneRejectionReason;

  constructor(reason: PhoneRejectionReason) {
    // Deliberately digit-free: this message is safe to log.
    super(`phone number rejected: ${reason}`);
    this.name = 'PhoneNormalizationError';
    this.reason = reason;
  }
}

/**
 * Normalize a raw provider-supplied value to E.164.
 *
 * Throws {@link PhoneNormalizationError} rather than returning a best guess. A bare
 * national number (`0612345678`), an international access prefix (`0033612345678`)
 * and a plus-less number (`33612345678`) are all ambiguous without knowing the
 * dialing region, so all three are rejected.
 */
export function normalizePhone(raw: string): string {
  if (typeof raw !== 'string') {
    throw new PhoneNormalizationError('empty');
  }

  const withoutChannel = raw.trim().replace(CHANNEL_PREFIX, '').trim();
  if (withoutChannel.length === 0) {
    throw new PhoneNormalizationError('empty');
  }

  const compact = withoutChannel.replace(SEPARATORS, '');
  if (compact.length === 0) {
    throw new PhoneNormalizationError('empty');
  }

  // Anything that is not a leading `+` followed by digits is not a phone number.
  if (!/^\+?\d+$/.test(compact)) {
    throw new PhoneNormalizationError('invalid_characters');
  }

  if (!compact.startsWith('+')) {
    // Either an international access prefix (`00…`, `011…`) or a national number.
    // Both require a dialing region we refuse to assume.
    throw new PhoneNormalizationError('missing_country_code');
  }

  if (!E164.test(compact)) {
    // A `+0…` country code is invalid; everything else here is a length problem.
    throw new PhoneNormalizationError(
      compact.startsWith('+0') ? 'missing_country_code' : 'invalid_format',
    );
  }

  return compact;
}

/** Normalize without throwing, for routing paths that must answer rather than fail. */
export function tryNormalizePhone(
  raw: string,
): { ok: true; phone: string } | { ok: false; reason: PhoneRejectionReason } {
  try {
    return { ok: true, phone: normalizePhone(raw) };
  } catch (error) {
    if (error instanceof PhoneNormalizationError) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

/**
 * Log-safe rendering of a phone number: country-code head and two trailing digits.
 * Never log the full value.
 */
export function redactPhone(phoneE164: string): string {
  if (!E164.test(phoneE164)) {
    return '[redacted]';
  }
  return `${phoneE164.slice(0, 3)}…${phoneE164.slice(-2)}`;
}
