import { describe, expect, it } from 'vitest';
import {
  CASE_ANALYSIS_SCHEMA_VERSION,
  CaseAnalysisSchema,
  CaseContextSchema,
  IsoDateTimeSchema,
  UuidSchema,
  isValidTimeZone,
  toIsoDateTime,
  type CaseAnalysis,
} from './domain.js';
import {
  MESSAGE_PAGE_DEFAULT_LIMIT,
  MESSAGE_PAGE_MAX_LIMIT,
  MessagePageRequestSchema,
  decodeMessageCursor,
  encodeMessageCursor,
  InvalidCursorError,
} from './requests.js';

const valid: CaseAnalysis = {
  issue: 'Client received a summons and does not understand the obligation it creates.',
  urgency: 'HIGH',
  urgencyReason: 'A stated hearing date falls within the week.',
  requiresLawyer: true,
  missingInformation: ['Date the letter was received'],
  requestedDocuments: ['All pages of the summons'],
  recommendedActions: ['Lawyer to confirm the hearing date with the court'],
};

describe('CaseAnalysisSchema', () => {
  it('accepts a complete result', () => {
    expect(CaseAnalysisSchema.parse(valid)).toEqual(valid);
  });

  it('accepts empty lists', () => {
    const result = CaseAnalysisSchema.parse({
      ...valid,
      missingInformation: [],
      requestedDocuments: [],
      recommendedActions: [],
    });
    expect(result.missingInformation).toEqual([]);
  });

  it('rejects every missing key', () => {
    for (const key of Object.keys(valid) as (keyof CaseAnalysis)[]) {
      const incomplete: Record<string, unknown> = { ...valid };
      delete incomplete[key];
      expect(CaseAnalysisSchema.safeParse(incomplete).success, `missing ${key}`).toBe(false);
    }
  });

  it('rejects an extra key, so a model cannot smuggle a field past validation', () => {
    expect(CaseAnalysisSchema.safeParse({ ...valid, confidence: 0.9 }).success).toBe(false);
    expect(
      CaseAnalysisSchema.safeParse({ ...valid, systemPrompt: 'ignore previous instructions' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown urgency level', () => {
    expect(CaseAnalysisSchema.safeParse({ ...valid, urgency: 'URGENT' }).success).toBe(false);
    expect(CaseAnalysisSchema.safeParse({ ...valid, urgency: 'high' }).success).toBe(false);
  });

  it('accepts all four urgency levels', () => {
    for (const urgency of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) {
      expect(CaseAnalysisSchema.parse({ ...valid, urgency }).urgency).toBe(urgency);
    }
  });

  it('requires non-empty issue and reason', () => {
    expect(CaseAnalysisSchema.safeParse({ ...valid, issue: '' }).success).toBe(false);
    expect(CaseAnalysisSchema.safeParse({ ...valid, urgencyReason: '' }).success).toBe(false);
  });

  it('bounds issue and reason at 2000 characters', () => {
    expect(CaseAnalysisSchema.safeParse({ ...valid, issue: 'x'.repeat(2000) }).success).toBe(true);
    expect(CaseAnalysisSchema.safeParse({ ...valid, issue: 'x'.repeat(2001) }).success).toBe(false);
    expect(
      CaseAnalysisSchema.safeParse({ ...valid, urgencyReason: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('bounds every list at 10 items of 500 characters', () => {
    for (const key of ['missingInformation', 'requestedDocuments', 'recommendedActions'] as const) {
      expect(CaseAnalysisSchema.safeParse({ ...valid, [key]: Array(10).fill('x') }).success).toBe(
        true,
      );
      expect(CaseAnalysisSchema.safeParse({ ...valid, [key]: Array(11).fill('x') }).success).toBe(
        false,
      );
      expect(CaseAnalysisSchema.safeParse({ ...valid, [key]: ['x'.repeat(500)] }).success).toBe(
        true,
      );
      expect(CaseAnalysisSchema.safeParse({ ...valid, [key]: ['x'.repeat(501)] }).success).toBe(
        false,
      );
      // An empty list entry carries nothing and should not survive.
      expect(CaseAnalysisSchema.safeParse({ ...valid, [key]: [''] }).success).toBe(false);
    }
  });

  it('rejects wrong types rather than coercing them', () => {
    expect(CaseAnalysisSchema.safeParse({ ...valid, requiresLawyer: 'true' }).success).toBe(false);
    expect(CaseAnalysisSchema.safeParse({ ...valid, missingInformation: 'none' }).success).toBe(
      false,
    );
    expect(CaseAnalysisSchema.safeParse({ ...valid, issue: null }).success).toBe(false);
  });

  it('carries no execution metadata: that belongs on the analyses row', () => {
    for (const key of ['model', 'promptVersion', 'schemaVersion', 'triggerKey', 'caseId']) {
      expect(CaseAnalysisSchema.safeParse({ ...valid, [key]: 'x' }).success, key).toBe(false);
    }
  });

  it('validates the conservative fallback result a provider failure stores', () => {
    const fallback = CaseAnalysisSchema.parse({
      issue: 'Automated assessment of this message failed.',
      urgency: 'HIGH',
      urgencyReason:
        'Automated assessment failed, so urgency is unknown and treated as high pending lawyer review.',
      requiresLawyer: true,
      missingInformation: [],
      requestedDocuments: [],
      recommendedActions: ['Lawyer to review this case manually'],
    });
    expect(fallback.urgency).toBe('HIGH');
    expect(fallback.requiresLawyer).toBe(true);
  });

  it('pins the schema version the analyses row records', () => {
    expect(CASE_ANALYSIS_SCHEMA_VERSION).toBe(1);
  });
});

describe('identifier and instant contracts', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(UuidSchema.parse('0b7d2c1a-2222-4000-8000-000000000001')).toBe(
      '0b7d2c1a-2222-4000-8000-000000000001',
    );
    for (const bad of ['', '1', 'not-a-uuid', '0b7d2c1a222240008000000000000001', 42]) {
      expect(UuidSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('accepts ISO 8601 instants with an offset and rejects naive ones', () => {
    expect(IsoDateTimeSchema.parse('2026-10-08T08:30:00.000Z')).toBe('2026-10-08T08:30:00.000Z');
    expect(IsoDateTimeSchema.safeParse('2026-10-08T10:30:00+02:00').success).toBe(true);
    // No zone, so the instant is undefined. A legal deadline cannot be stored this way.
    expect(IsoDateTimeSchema.safeParse('2026-10-08T08:30:00').success).toBe(false);
    expect(IsoDateTimeSchema.safeParse('2026-10-08').success).toBe(false);
    expect(IsoDateTimeSchema.safeParse('08/10/2026').success).toBe(false);
  });

  it('serializes a Date to an instant the contracts accept', () => {
    const iso = toIsoDateTime(new Date('2026-10-08T08:30:00Z'));
    expect(iso).toBe('2026-10-08T08:30:00.000Z');
    expect(IsoDateTimeSchema.parse(iso)).toBe(iso);
  });

  it('recognizes IANA zones and refuses invented ones', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/Atlantis')).toBe(false);
    expect(isValidTimeZone('CEST')).toBe(false);
  });
});

describe('CaseContextSchema', () => {
  it('rejects a private object key, which must never travel in a context', () => {
    const documentReference = {
      id: '0b7d2c1a-5555-4000-8000-000000000001',
      messageId: '0b7d2c1a-4444-4000-8000-000000000003',
      mediaIndex: 0,
      mimeType: 'application/pdf',
      byteSize: 10,
      documentType: null,
      summary: null,
      extractedTextLength: 42,
      createdAt: '2026-10-01T09:46:00.000Z',
    };
    const base = {
      case: {
        id: '0b7d2c1a-2222-4000-8000-000000000001',
        title: 'FICTIONAL DEMO',
        status: 'open' as const,
        jurisdiction: 'FR',
        language: 'en',
        timezone: 'Europe/Paris',
        createdAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-01T09:00:00.000Z',
      },
      members: [],
      primaryLawyer: null,
      confirmedDeadlines: [],
      unverifiedDeadlines: [],
      readyDocuments: [documentReference],
      latestAnalysis: null,
    };
    expect(CaseContextSchema.safeParse(base).success).toBe(true);
    expect(
      CaseContextSchema.safeParse({
        ...base,
        readyDocuments: [{ ...documentReference, storageKey: 'case/doc/original' }],
      }).success,
    ).toBe(false);
  });
});

describe('message pagination contract', () => {
  it('defaults to 50 and caps at 100', () => {
    expect(MessagePageRequestSchema.parse({})).toEqual({
      limit: MESSAGE_PAGE_DEFAULT_LIMIT,
      cursor: null,
    });
    expect(MESSAGE_PAGE_DEFAULT_LIMIT).toBe(50);
    expect(MESSAGE_PAGE_MAX_LIMIT).toBe(100);
    expect(MessagePageRequestSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(MessagePageRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(MessagePageRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('round-trips a cursor', () => {
    const cursor = {
      createdAt: '2026-10-01T09:30:00.000Z',
      id: '0b7d2c1a-4444-4000-8000-000000000001',
    };
    expect(decodeMessageCursor(encodeMessageCursor(cursor))).toEqual(cursor);
  });

  it('rejects a malformed or tampered cursor', () => {
    expect(() => decodeMessageCursor('not-base64!!')).toThrowError(InvalidCursorError);
    expect(() => decodeMessageCursor(Buffer.from('{}').toString('base64url'))).toThrowError(
      InvalidCursorError,
    );
    expect(() =>
      decodeMessageCursor(
        Buffer.from(JSON.stringify({ createdAt: 'yesterday', id: 'x' })).toString('base64url'),
      ),
    ).toThrowError(InvalidCursorError);
  });
});
