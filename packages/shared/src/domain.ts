import { z } from 'zod';

/**
 * Domain contracts shared by every application and package.
 *
 * This module imports no database driver, no ORM and no provider SDK: it is the
 * dependency root (`shared ← db`, `shared ← ai`).
 *
 * Wire convention: all identifiers are UUIDs and all instants are ISO 8601 strings
 * with an explicit offset. The data service converts `timestamptz` to ISO at its
 * boundary so these contracts stay directly serializable.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** ISO 8601 instant with an explicit offset, e.g. `2026-10-04T08:30:00.000Z`. */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** An IANA time zone name. Validity against the host's zone database is checked separately. */
export const TimeZoneSchema = z.string().min(1).max(64);

/** Serialize an instant the way every contract above expects. */
export function toIsoDateTime(value: Date): IsoDateTime {
  return value.toISOString();
}

/** True when the host's ICU data recognizes the zone. Used to validate case fixtures. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Enumerations. Each mirrors a PostgreSQL enum type in `@lexora/db`.
// ---------------------------------------------------------------------------

export const PERSON_ROLES = ['client', 'lawyer'] as const;
export const PersonRoleSchema = z.enum(PERSON_ROLES);
export type PersonRole = z.infer<typeof PersonRoleSchema>;

export const CASE_STATUSES = ['open', 'closed'] as const;
export const CaseStatusSchema = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

/** A person's role *within one case*, independent of their global `people.role`. */
export const CASE_MEMBER_ROLES = ['client', 'lawyer'] as const;
export const CaseMemberRoleSchema = z.enum(CASE_MEMBER_ROLES);
export type CaseMemberRole = z.infer<typeof CaseMemberRoleSchema>;

export const CONVERSATION_CHANNELS = ['whatsapp', 'voice'] as const;
export const ConversationChannelSchema = z.enum(CONVERSATION_CHANNELS);
export type ConversationChannel = z.infer<typeof ConversationChannelSchema>;

export const CONVERSATION_STATUSES = ['open', 'completing', 'complete'] as const;
export const ConversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const MessageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

/**
 * `text` — a client or assistant turn. `media` — an attachment-carrying message whose
 * text may be empty. `system` — output the platform generated, with no human author.
 */
export const MESSAGE_KINDS = ['text', 'media', 'system'] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/**
 * Outbound delivery lifecycle, tracked per message and separate from the escalation's
 * own status. `none` is the resting value for inbound messages. `accepted` means the
 * provider took the request; it is never evidence of delivery. `delivery_unknown`
 * requires operator inspection and forbids an automatic resend.
 */
export const DELIVERY_STATUSES = [
  'none',
  'pending',
  'sending',
  'accepted',
  'delivered',
  'failed',
  'delivery_unknown',
  'simulated',
] as const;
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

/** `pending → stored → extracting → ready`, with `rejected` and `failed` terminal. */
export const DOCUMENT_STATUSES = [
  'pending',
  'stored',
  'extracting',
  'ready',
  'rejected',
  'failed',
] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/**
 * A date a model extracted stays `unverified` forever unless a human confirms it.
 * Nothing in this system promotes `unverified` to `confirmed` automatically.
 */
export const VERIFICATION_STATUSES = ['unverified', 'confirmed'] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * `ok` — the model returned a schema-valid assessment. `fallback` — automated
 * assessment failed and a conservative review-required result was stored instead.
 * There is no `failed` status: a provider failure is a persisted `fallback`, not a
 * missing row.
 */
export const ANALYSIS_STATUSES = ['ok', 'fallback'] as const;
export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);
export type AnalysisStatus = z.infer<typeof AnalysisStatusSchema>;

/**
 * Escalation lifecycle. `accepted` and `delivered` are deliberately distinct.
 * `blocked_*` states are visible operational failures, not silent no-ops.
 * `simulated` is what a fake provider records; it never means `delivered`.
 */
export const ESCALATION_STATUSES = [
  'pending',
  'sending',
  'accepted',
  'delivered',
  'failed',
  'delivery_unknown',
  'blocked_no_lawyer',
  'blocked_template_required',
  'simulated',
] as const;
export const EscalationStatusSchema = z.enum(ESCALATION_STATUSES);
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

// ---------------------------------------------------------------------------
// CaseAnalysis: the public analysis result contract
// ---------------------------------------------------------------------------

export const URGENCY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const UrgencySchema = z.enum(URGENCY_LEVELS);
export type Urgency = z.infer<typeof UrgencySchema>;

const ANALYSIS_TEXT_MAX = 2_000;
const ANALYSIS_LIST_MAX_ITEMS = 10;
const ANALYSIS_LIST_ITEM_MAX = 500;

const analysisList = () =>
  z.array(z.string().min(1).max(ANALYSIS_LIST_ITEM_MAX)).max(ANALYSIS_LIST_MAX_ITEMS);

/**
 * The model-facing analysis result. Strict: every key is required and unknown keys are
 * rejected, so a model cannot smuggle extra fields past validation.
 *
 * Execution metadata (model id, prompt version, context ids) lives on the `analyses`
 * row, deliberately outside this public result.
 *
 * A structurally valid value is still a model assessment, not a verified legal conclusion.
 */
export const CaseAnalysisSchema = z.strictObject({
  issue: z.string().min(1).max(ANALYSIS_TEXT_MAX),
  urgency: UrgencySchema,
  urgencyReason: z.string().min(1).max(ANALYSIS_TEXT_MAX),
  requiresLawyer: z.boolean(),
  missingInformation: analysisList(),
  requestedDocuments: analysisList(),
  recommendedActions: analysisList(),
});
export type CaseAnalysis = z.infer<typeof CaseAnalysisSchema>;

/** The current `analyses.schema_version`. Bump when `CaseAnalysisSchema` changes shape. */
export const CASE_ANALYSIS_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Entity contracts
// ---------------------------------------------------------------------------

export const PersonSchema = z.strictObject({
  id: UuidSchema,
  displayName: z.string(),
  phoneE164: z.string(),
  role: PersonRoleSchema,
  /** Non-null means explicitly enrolled in the demo. Null means known but not enrolled. */
  enrolledAt: IsoDateTimeSchema.nullable(),
  /** Drives the 24-hour WhatsApp service window, per recipient. */
  lastWhatsappInboundAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Person = z.infer<typeof PersonSchema>;

export const CaseSchema = z.strictObject({
  id: UuidSchema,
  title: z.string(),
  status: CaseStatusSchema,
  /** Explicit case field. Never inferred from a phone number. */
  jurisdiction: z.string(),
  language: z.string(),
  timezone: TimeZoneSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Case = z.infer<typeof CaseSchema>;

export const CaseMemberSchema = z.strictObject({
  caseId: UuidSchema,
  personId: UuidSchema,
  role: CaseMemberRoleSchema,
  isPrimary: z.boolean(),
  displayName: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type CaseMember = z.infer<typeof CaseMemberSchema>;

export const ConversationSchema = z.strictObject({
  id: UuidSchema,
  caseId: UuidSchema,
  personId: UuidSchema,
  channel: ConversationChannelSchema,
  providerSessionKey: z.string().nullable(),
  status: ConversationStatusSchema,
  summary: z.string().nullable(),
  summaryThroughMessageId: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z.strictObject({
  id: UuidSchema,
  caseId: UuidSchema,
  conversationId: UuidSchema,
  /** Null for system-generated output, which has no human author. */
  personId: UuidSchema.nullable(),
  direction: MessageDirectionSchema,
  kind: MessageKindSchema,
  text: z.string(),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  deliveryStatus: DeliveryStatusSchema,
  metadata: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const DocumentMetadataSchema = z.looseObject({
  documentType: z.string().optional(),
  summary: z.string().optional(),
  dateMentions: z
    .array(
      z.strictObject({
        text: z.string(),
        /** Null when the model could not resolve the mention to a date. */
        isoDate: z.string().nullable(),
        sourcePage: z.number().int().nullable(),
      }),
    )
    .optional(),
});
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;

export const DocumentSchema = z.strictObject({
  id: UuidSchema,
  caseId: UuidSchema,
  messageId: UuidSchema,
  mediaIndex: z.number().int().nonnegative(),
  /** Private object key. Never a URL, never public, never handed to a browser. */
  storageKey: z.string(),
  mimeType: z.string(),
  /** Null until the object has actually been stored. */
  byteSize: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  status: DocumentStatusSchema,
  extractedText: z.string().nullable(),
  metadata: DocumentMetadataSchema,
  errorCode: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Document = z.infer<typeof DocumentSchema>;

/**
 * What `CaseContext` exposes about a ready document: enough to cite and count it,
 * with no private object key and no extracted body. The analysis pipeline fetches
 * text separately under its own character budget.
 */
export const DocumentReferenceSchema = z.strictObject({
  id: UuidSchema,
  messageId: UuidSchema,
  mediaIndex: z.number().int().nonnegative(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative().nullable(),
  documentType: z.string().nullable(),
  summary: z.string().nullable(),
  extractedTextLength: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
});
export type DocumentReference = z.infer<typeof DocumentReferenceSchema>;

export const DeadlineSchema = z.strictObject({
  id: UuidSchema,
  caseId: UuidSchema,
  title: z.string(),
  dueAt: IsoDateTimeSchema,
  timezone: TimeZoneSchema,
  sourceDocumentId: UuidSchema.nullable(),
  sourceMessageId: UuidSchema.nullable(),
  verificationStatus: VerificationStatusSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Deadline = z.infer<typeof DeadlineSchema>;

export const AnalysisSchema = z.strictObject({
  id: UuidSchema,
  caseId: UuidSchema,
  conversationId: UuidSchema,
  /** Identifies the input event this analysis answers. Unique: the idempotency key. */
  triggerKey: z.string(),
  result: CaseAnalysisSchema,
  status: AnalysisStatusSchema,
  model: z.string(),
  promptVersion: z.string(),
  schemaVersion: z.number().int().positive(),
  contextMessageIds: z.array(UuidSchema),
  contextDocumentIds: z.array(UuidSchema),
  createdAt: IsoDateTimeSchema,
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const EscalationSchema = z.strictObject({
  id: UuidSchema,
  caseId: UuidSchema,
  analysisId: UuidSchema,
  /** Null when the case has no assigned lawyer: a visible `blocked_no_lawyer` failure. */
  lawyerId: UuidSchema.nullable(),
  outboundMessageId: UuidSchema.nullable(),
  status: EscalationStatusSchema,
  reason: z.string(),
  providerMessageId: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Escalation = z.infer<typeof EscalationSchema>;

// ---------------------------------------------------------------------------
// Composite reads
// ---------------------------------------------------------------------------

/**
 * Everything a triage step may know about a case without touching private storage.
 *
 * Deliberately absent: provider secrets, private object keys or URLs, and any
 * credential. Deadlines are split so a caller cannot accidentally treat a
 * model-extracted date as a confirmed one.
 */
export const CaseContextSchema = z.strictObject({
  case: CaseSchema,
  members: z.array(CaseMemberSchema),
  primaryLawyer: CaseMemberSchema.nullable(),
  confirmedDeadlines: z.array(DeadlineSchema),
  unverifiedDeadlines: z.array(DeadlineSchema),
  readyDocuments: z.array(DocumentReferenceSchema),
  latestAnalysis: AnalysisSchema.nullable(),
});
export type CaseContext = z.infer<typeof CaseContextSchema>;

/** Result of resolving a person to one active case. Never silently picks a winner. */
export type ActiveCaseLookup =
  | { kind: 'found'; case: Case }
  | { kind: 'none' }
  | { kind: 'ambiguous'; caseIds: Uuid[] };

export const MessagePageSchema = z.strictObject({
  messages: z.array(MessageSchema),
  /** Opaque cursor for the next page; null when the page is the last one. */
  nextCursor: z.string().nullable(),
});
export type MessagePage = z.infer<typeof MessagePageSchema>;
