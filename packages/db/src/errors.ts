/**
 * Data-service errors.
 *
 * Messages carry identifiers only. The design permits logging request, job, case,
 * message, analysis and escalation ids; it forbids message bodies, phone numbers,
 * tokens and document URLs. These errors are built to be safe to log verbatim.
 */

export class CaseNotFoundError extends Error {
  constructor(readonly caseId: string) {
    super(`case not found: ${caseId}`);
    this.name = 'CaseNotFoundError';
  }
}

export class ConversationNotFoundError extends Error {
  constructor(readonly conversationId: string) {
    super(`conversation not found: ${conversationId}`);
    this.name = 'ConversationNotFoundError';
  }
}

export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(`message not found: ${messageId}`);
    this.name = 'MessageNotFoundError';
  }
}

/**
 * A write tried to join rows across two different cases.
 *
 * Most such attempts are rejected by a composite foreign key before reaching here.
 * This error covers the invariants that a foreign key cannot express — notably that
 * a conversation summary points at a message of *that* conversation.
 */
export class OwnershipViolationError extends Error {
  constructor(
    readonly detail: {
      readonly relation: string;
      readonly expected: string;
      readonly actual: string;
    },
  ) {
    super(
      `ownership violation on ${detail.relation}: expected ${detail.expected}, found ${detail.actual}`,
    );
    this.name = 'OwnershipViolationError';
  }
}

/** A case or deadline was given a zone the host's zone database does not recognize. */
export class InvalidTimeZoneError extends Error {
  constructor(readonly timezone: string) {
    super(`not an IANA time zone: ${timezone}`);
    this.name = 'InvalidTimeZoneError';
  }
}
