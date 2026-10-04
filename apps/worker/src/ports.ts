import type {
  AnalysisInput,
  AnalysisResult,
  ConverseInput,
  LegalAuditEntry,
  LegalSource,
} from '@lexora/ai';

/** Thin envelopes around @lexora/ai and the WhatsApp provider, so processInbound runs identically on fakes and live services. */
export interface AiPort {
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
  /** Intake agent: the next WhatsApp message to the client (one question, no legal advice). */
  converse(input: ConverseInput): Promise<{ text: string }>;
  transcribe(input: { bytes: Uint8Array; fileName: string }): Promise<{ text: string }>;
  extract(input: {
    bytes: Uint8Array;
    mimeType: string;
    fileName?: string;
  }): Promise<{ text: string; documentType: string; summary?: string }>;
  embed?(texts: string[]): Promise<number[][]>;
}

export interface Messenger {
  /** 'simulated' means nothing left the machine. */
  send(
    toE164: string,
    body: string,
  ): Promise<{ status: 'sent' | 'simulated'; providerMessageId?: string }>;
}

export interface LegalPort {
  gather(
    question: string,
    opts: { clientIdentifiers: string[] },
  ): Promise<{ sources: LegalSource[]; audit: LegalAuditEntry[] }>;
}

/** Downloads an inbound media file (media reference from the inbound message). */
export interface MediaDownloader {
  download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

/** One JSON line per event. Callers never pass message content, only ids, counts and masked numbers. */
export const jsonLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'info', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'warn', event, ...fields })),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {} };

/** +33600000002 -> +336*****002 */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '***';
  return e164.slice(0, 4) + '*'.repeat(e164.length - 7) + e164.slice(-3);
}
