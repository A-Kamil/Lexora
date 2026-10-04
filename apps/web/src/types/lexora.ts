/**
 * Types of the lawyer dashboard.
 *
 * `Urgency` and `CaseAnalysis` mirror `CaseAnalysisSchema` in
 * `packages/shared/src/domain.ts` (same keys, same values). Everything else is
 * the view model the dashboard expects from the backend's future read API:
 * keep it aligned with the `cases`, `messages`, `documents`, `deadlines`,
 * `analyses` and `escalations` tables.
 */

export type Urgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface CaseAnalysis {
  issue: string;
  urgency: Urgency;
  urgencyReason: string;
  requiresLawyer: boolean;
  missingInformation: string[];
  requestedDocuments: string[];
  recommendedActions: string[];
}

/** `fallback` = automated assessment failed; the result is deliberately conservative. */
export type AnalysisStatus = 'ok' | 'fallback';

export interface AnalysisRecord {
  id: string;
  createdAt: string;
  status: AnalysisStatus;
  result: CaseAnalysis;
  /** Documents actually read to produce this analysis — never claim more. */
  reviewedDocumentCount: number;
}

export type EscalationStatus =
  | 'pending'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'failed'
  | 'delivery_unknown'
  | 'blocked_no_lawyer'
  | 'blocked_template_required'
  | 'simulated';

export interface Escalation {
  status: EscalationStatus;
  updatedAt: string;
}

export type DocumentStatus = 'pending' | 'stored' | 'extracting' | 'ready' | 'rejected' | 'failed';

export type DocumentCategory =
  | 'decision'
  | 'proces_verbal'
  | 'identite'
  | 'preuve'
  | 'correspondance'
  | 'autre';

/** A date found in a document by the model. Always unverified. */
export interface DateMention {
  text: string;
  isoDate: string | null;
  sourcePage: number | null;
}

export interface CaseDocument {
  id: string;
  name: string;
  category: DocumentCategory;
  mimeType: string;
  byteSize: number;
  status: DocumentStatus;
  receivedAt: string;
  summary: string | null;
  extractedText: string | null;
  dateMentions: DateMention[];
  errorReason: string | null;
}

export interface CaseMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  author: string;
  text: string;
  createdAt: string;
  documentIds: string[];
}

export type DeadlineVerification = 'unverified' | 'confirmed';

export interface Deadline {
  id: string;
  title: string;
  dueAt: string;
  verification: DeadlineVerification;
}

export interface CaseSummary {
  id: string;
  title: string;
  clientName: string;
  status: 'open' | 'closed';
  urgency: Urgency;
  analysisStatus: AnalysisStatus;
  issue: string;
  lastActivityAt: string;
  documentCount: number;
  escalationStatus: EscalationStatus | null;
  nextDeadline: { title: string; dueAt: string } | null;
  timezone: string;
}

export interface CaseList {
  lawyerName: string;
  cases: CaseSummary[];
}

export interface CaseDetail {
  id: string;
  title: string;
  status: 'open' | 'closed';
  jurisdiction: string;
  language: string;
  timezone: string;
  clientName: string;
  lawyerName: string;
  analysis: AnalysisRecord | null;
  history: AnalysisRecord[];
  escalation: Escalation | null;
  deadlines: Deadline[];
  documents: CaseDocument[];
  messages: CaseMessage[];
}

export interface Session {
  lawyerName: string;
  startedAt: string;
}
