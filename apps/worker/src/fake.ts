import { buildContext, type AnalysisInput, type ConverseInput, type AnalysisResult, type CaseAnalysis, type LegalSource } from '@lexora/ai';
import type { AiPort, LegalPort, MediaDownloader, Messenger } from './ports.js';

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const RULES: { urgency: CaseAnalysis['urgency']; words: string[]; reason: string }[] = [
  { urgency: 'CRITICAL', words: ['garde à vue', 'police custody', 'arrested', 'arrêté'], reason: 'Police custody or arrest mentioned (fake AI keyword rule).' },
  { urgency: 'HIGH', words: ['convocation', 'hearing', 'audience'], reason: 'Summons or hearing mentioned (fake AI keyword rule).' },
];

/** Deterministic keyword triage on the latest message, used in tests and whenever AI_MODE=fake. */
export function fakeTriage(text: string): { urgency: CaseAnalysis['urgency']; reason: string } {
  const t = fold(text);
  for (const r of RULES) if (r.words.some((w) => t.includes(fold(w)))) return { urgency: r.urgency, reason: r.reason };
  return { urgency: 'LOW', reason: 'No urgency keyword found (fake AI keyword rule).' };
}

const ISSUES: Record<CaseAnalysis['urgency'], string> = {
  CRITICAL: 'garde à vue',
  HIGH: 'convocation / audience',
  MEDIUM: 'information nouvelle',
  LOW: 'question générale',
};

export const FAKE_INTAKE_FIRST = 'Bonjour, vous êtes en contact avec l\'accueil automatique du cabinet (ceci n\'est pas un conseil juridique). Pouvez-vous me dire ce qui s\'est passé ?';

export class FakeAi implements AiPort {
  calls = { analyze: [] as AnalysisInput[], converse: [] as ConverseInput[], transcribe: 0, extract: 0 };

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    this.calls.analyze.push(input);
    const ctx = buildContext(input);
    const { urgency, reason } = fakeTriage(input.trigger.text);
    const high = urgency === 'HIGH' || urgency === 'CRITICAL';
    return {
      status: 'ok',
      model: 'fake',
      includedMessageIds: ctx.includedMessageIds,
      includedDocumentIds: ctx.includedDocumentIds,
      omitted: ctx.omitted,
      analysis: {
        issue: ISSUES[urgency],
        urgency,
        urgencyReason: reason,
        requiresLawyer: high,
        missingInformation: high ? ['Lieu de la garde à vue'] : [],
        requestedDocuments: [],
        recommendedActions: high ? ['Rappeler le client'] : [],
      },
    };
  }

  /** Deterministic intake turn: introduction first, then one follow-up question. */
  async converse(input: ConverseInput) {
    this.calls.converse.push(input);
    const first = !input.history.some((m) => m.role === 'assistant');
    return {
      text: first
        ? FAKE_INTAKE_FIRST
        : 'Merci. Avez-vous un document à nous transmettre (photo ou PDF) ?',
    };
  }

  /** The "audio" bytes are the transcript itself. */
  async transcribe(input: { bytes: Uint8Array }) {
    this.calls.transcribe++;
    return { text: new TextDecoder().decode(input.bytes).trim() };
  }

  async extract(input: { bytes: Uint8Array }) {
    this.calls.extract++;
    return { text: new TextDecoder().decode(input.bytes).trim(), documentType: 'other' };
  }
}

/** Records every send; nothing ever leaves the machine. */
export class FakeMessenger implements Messenger {
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
    return { status: 'simulated' as const };
  }
}

export const MOCK_SOURCE: LegalSource = { reference: 'MOCK', title: 'Mock legal source', excerpt: 'Fixture used without credentials.', url: null };

export class MockLegal implements LegalPort {
  questions: { question: string; clientIdentifiers: string[] }[] = [];
  constructor(private readonly sources: LegalSource[] = [MOCK_SOURCE]) {}
  async gather(question: string, opts: { clientIdentifiers: string[] }) {
    this.questions.push({ question, clientIdentifiers: opts.clientIdentifiers });
    return { sources: this.sources, audit: [] };
  }
}

/** Serves fixed bytes per URL; unknown URLs fail like a network error. */
export class FakeDownloader implements MediaDownloader {
  constructor(private readonly files: Record<string, { bytes: Uint8Array; contentType?: string }> = {}) {}
  async download(url: string) {
    const f = this.files[url];
    if (!f) throw new Error('download failed (fake)');
    return { bytes: f.bytes, contentType: f.contentType ?? null };
  }
}
