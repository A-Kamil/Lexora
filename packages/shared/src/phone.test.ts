import { describe, expect, it } from 'vitest';
import {
  PhoneNormalizationError,
  normalizePhone,
  redactPhone,
  tryNormalizePhone,
} from './phone.js';

describe('normalizePhone', () => {
  it('strips a channel prefix and keeps the E.164 value', () => {
    expect(normalizePhone('whatsapp:+33612345678')).toBe('+33612345678');
    expect(normalizePhone('WhatsApp:+33612345678')).toBe('+33612345678');
    expect(normalizePhone('sms:+14155550123')).toBe('+14155550123');
    expect(normalizePhone('tel:+447700900123')).toBe('+447700900123');
  });

  it('removes separators without changing the number', () => {
    const expected = '+33612345678';
    for (const raw of [
      '+33 6 12 34 56 78',
      '+33-6-12-34-56-78',
      '+33 (6) 12.34.56.78',
      '  +33612345678  ',
      '+33\u00a06\u00a012\u00a034\u00a056\u00a078',
    ]) {
      expect(normalizePhone(raw)).toBe(expected);
    }
  });

  it('is stable: normalizing an already-normalized number is a no-op', () => {
    const once = normalizePhone('whatsapp:+33 6 12 34 56 78');
    expect(normalizePhone(once)).toBe(once);
    expect(normalizePhone(normalizePhone(once))).toBe(once);
  });

  it('rejects a bare national number instead of guessing a region', () => {
    // `0612345678` is a French mobile, a Dutch mobile, or neither. Nothing here knows.
    expect(() => normalizePhone('0612345678')).toThrowError(PhoneNormalizationError);
    expect(tryNormalizePhone('0612345678')).toEqual({
      ok: false,
      reason: 'missing_country_code',
    });
  });

  it('rejects an international access prefix, which is not a country code', () => {
    // `00` in Europe, `011` in North America: a dialing convention, not part of E.164.
    expect(tryNormalizePhone('0033612345678')).toEqual({
      ok: false,
      reason: 'missing_country_code',
    });
    expect(tryNormalizePhone('01133612345678')).toEqual({
      ok: false,
      reason: 'missing_country_code',
    });
  });

  it('rejects a plus-less number even when it looks international', () => {
    expect(tryNormalizePhone('33612345678')).toEqual({ ok: false, reason: 'missing_country_code' });
    expect(tryNormalizePhone('whatsapp:33612345678')).toEqual({
      ok: false,
      reason: 'missing_country_code',
    });
  });

  it('rejects a country code starting with zero', () => {
    expect(tryNormalizePhone('+0612345678')).toEqual({ ok: false, reason: 'missing_country_code' });
  });

  it('rejects empty, non-numeric and out-of-range values', () => {
    expect(tryNormalizePhone('')).toEqual({ ok: false, reason: 'empty' });
    expect(tryNormalizePhone('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(tryNormalizePhone('whatsapp:')).toEqual({ ok: false, reason: 'empty' });
    expect(tryNormalizePhone('+33abc12345')).toEqual({ ok: false, reason: 'invalid_characters' });
    expect(tryNormalizePhone("+33'; drop table people--")).toEqual({
      ok: false,
      reason: 'invalid_characters',
    });
    // Too short, then one digit past E.164's 15-digit maximum.
    expect(tryNormalizePhone('+33612')).toEqual({ ok: false, reason: 'invalid_format' });
    expect(tryNormalizePhone('+1234567890123456')).toEqual({ ok: false, reason: 'invalid_format' });
  });

  it('accepts the E.164 length boundaries', () => {
    expect(normalizePhone('+1234567')).toBe('+1234567');
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345');
  });

  it('never puts the digits in the error, so a rejection is safe to log', () => {
    try {
      normalizePhone('0612345678');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PhoneNormalizationError);
      expect((error as Error).message).toBe('phone number rejected: missing_country_code');
      expect((error as Error).message).not.toContain('0612345678');
    }
  });
});

describe('redactPhone', () => {
  it('keeps only the country-code head and two trailing digits', () => {
    expect(redactPhone('+33612345678')).toBe('+33…78');
    expect(redactPhone('+14155550123')).toBe('+14…23');
  });

  it('refuses to echo anything that is not E.164', () => {
    expect(redactPhone('0612345678')).toBe('[redacted]');
    expect(redactPhone('not a phone')).toBe('[redacted]');
  });
});
