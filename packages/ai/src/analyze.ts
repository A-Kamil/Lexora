import { z } from 'zod';
import type { Mistral } from '@mistralai/mistralai';
import { ANALYSIS_SYSTEM, wrapAsData } from './prompts.js';
import { textOf } from './client.js';

/** Public contract from the backend spec (strict, bounded). Move to @lexora/shared/domain when it exists. */
export const CaseAnalysisSchema = z
  .object({
    issue: z.string().min(1).max(2000),
    urgency: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    urgencyReason: z.string().min(1).max(2000),
    requiresLawyer: z.boolean(),
    missingInformation: z.array(z.string().max(500)).max(10),
    requestedDocuments: z.array(z.string().max(500)).max(10),
    recommendedActions: z.array(z.string().max(500)).max(10),
  })
  .strict();
export type CaseAnalysis = z.infer<typeof CaseAnalysisSchema>;

export interface ContextMessage { id: string; role: 'client' | 'assistant' | 'lawyer'; text: string; at: string }
export interface ContextDocument { id: string; documentType?: string; extractedText: string }
export interface LegalSource { reference: string; title: string; excerpt: string; url?: string | null }

export interface AnalysisInput {
  caseTitle: string;
  jurisdiction: string;
  language: string;
  priorMessages: ContextMessage[];
  trigger: ContextMessage;
  documents: ContextDocument[];
  legalSources?: LegalSource[];
  urgencyCriteria?: string; // plain text defined by the firm
}

export interface AnalysisResult {
  status: 'ok' | 'fallback';
  analysis: CaseAnalysis;
  model: string;
  includedMessageIds: string[];
  includedDocumentIds: string[];
  omitted: { messages: number; documents: number; truncatedDocumentIds: string[] };
}

const LIMITS = { messages: 30, documents: 5, perDocument: 12_000, total: 80_000 };

/** Bounded, deterministic context: prior messages, the trigger exactly once, ready documents, legal sources. */
export function buildContext(input: AnalysisInput) {
  const prior = input.priorMessages.filter((m) => m.id !== input.trigger.id).slice(-LIMITS.messages);
  const docs = input.documents.slice(0, LIMITS.documents);
  const truncated: string[] = [];
  let budget = LIMITS.total;
  const parts: string[] = [
    `CASE: ${input.caseTitle} | jurisdiction ${input.jurisdiction} | language ${input.language}`,
  ];
  if (input.urgencyCriteria) parts.push(`URGENCY CRITERIA (defined by the firm):\n${input.urgencyCriteria}`);
  for (const m of prior) {
    const line = `${m.at} ${m.role.toUpperCase()}: ${m.text}`;
    budget -= line.length;
    parts.push(wrapAsData(`MESSAGE ${m.id}`, line));
  }
  for (const d of docs) {
    let text = d.extractedText;
    if (text.length > LIMITS.perDocument) { text = text.slice(0, LIMITS.perDocument) + '\n[TRUNCATED]'; truncated.push(d.id); }
    if (text.length > budget) { text = text.slice(0, Math.max(0, budget)) + '\n[TRUNCATED]'; truncated.push(d.id); }
    budget -= text.length;
    parts.push(wrapAsData(`DOCUMENT ${d.id} (${d.documentType ?? 'unknown type'})`, text));
  }
  for (const s of input.legalSources ?? []) {
    parts.push(wrapAsData(`LEGAL SOURCE ${s.reference}`, `${s.title}\n${s.excerpt}`));
  }
  parts.push(wrapAsData(`LATEST MESSAGE ${input.trigger.id}`, `${input.trigger.at} ${input.trigger.role.toUpperCase()}: ${input.trigger.text}`));
  return {
    text: parts.join('\n\n'),
    includedMessageIds: [...prior.map((m) => m.id), input.trigger.id],
    includedDocumentIds: docs.map((d) => d.id),
    omitted: {
      messages: input.priorMessages.length - prior.length - (input.priorMessages.some((m) => m.id === input.trigger.id) ? 1 : 0),
      documents: input.documents.length - docs.length,
      truncatedDocumentIds: [...new Set(truncated)],
    },
  };
}

const jsonSchema = z.toJSONSchema(CaseAnalysisSchema);

function fallback(reason: string): CaseAnalysis {
  return {
    issue: 'Automated assessment unavailable',
    urgency: 'HIGH',
    urgencyReason: `Automated assessment failed (${reason}); review required by a lawyer.`,
    requiresLawyer: true,
    missingInformation: [],
    requestedDocuments: [],
    recommendedActions: ['Review the case manually'],
  };
}

/** Live analysis: structured output + independent Zod validation, one repair retry, conservative fallback. */
export async function analyzeCase(client: Mistral, input: AnalysisInput, model: string): Promise<AnalysisResult> {
  const ctx = buildContext(input);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: ANALYSIS_SYSTEM },
    { role: 'user', content: ctx.text },
  ];
  const base = { model, includedMessageIds: ctx.includedMessageIds, includedDocumentIds: ctx.includedDocumentIds, omitted: ctx.omitted };
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = '';
    try {
      const res = await client.chat.complete(
        {
          model,
          temperature: 0,
          messages,
          responseFormat: { type: 'json_schema', jsonSchema: { name: 'case_analysis', schemaDefinition: jsonSchema, strict: true } },
        },
        { timeoutMs: 45_000 },
      );
      raw = textOf(res.choices?.[0]?.message?.content);
      const parsed = CaseAnalysisSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { status: 'ok', analysis: parsed.data, ...base };
      messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `Invalid JSON for the schema: ${parsed.error.message.slice(0, 500)}. Return corrected JSON only.` });
    } catch (e) {
      if (e instanceof SyntaxError) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: 'Your answer was not valid JSON. Return JSON only.' });
        continue;
      }
      return { status: 'fallback', analysis: fallback(e instanceof Error ? e.name : 'provider error'), ...base };
    }
  }
  return { status: 'fallback', analysis: fallback('invalid output after retry'), ...base };
}
