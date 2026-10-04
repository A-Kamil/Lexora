# @lexora/ai

Mistral and legal-source building blocks for the worker, ported from the `emmanuel/` Python prototype. Pure functions: no database, no queue, no Twilio. The worker owns orchestration, persistence and fake/live switching.

| Module | Plan task | What it gives the worker |
|---|---|---|
| `analyze.ts` | Task 4 | `CaseAnalysisSchema` (spec contract), `buildContext` (bounded: 30 messages, 5 documents, 12k/doc, 80k total, trigger exactly once, omissions recorded), `analyzeCase` (json_schema output + Zod, one repair retry, conservative `HIGH` fallback). Optional `urgencyCriteria` text defined by the firm. |
| `ocr.ts` | Task 7 | `extractDocument({bytes,mimeType})` → `{text, pages, metadata:{documentType, summary, dateMentions[{text,isoDate,sourcePage}]}}` with Mistral OCR (PDF, DOCX, JPEG, PNG). Dates stay unverified. |
| `transcribe.ts` | voice | `transcribeVoice` with Voxtral (WhatsApp voice notes, call recordings). |
| `legal-context.ts` | Task 9 | `gatherLegalContext(question, {mode})` with `disabled` / `mock` / `direct`: Légifrance (codes in force), Judilibre (Cour de cassation), ECHR (local official text). `legalTools` + `runLegalTool` for a function-calling agent. Every lookup returns an audit entry. |
| `legal/redact.ts` | review focus 2 | Client name, phone and e-mail removed from every query sent to a public API (decided by code). |
| `legal/echr.ts` + `data/cedh.json` | Task 9 | European Convention on Human Rights + protocols, official French text from the team's lawyer, 116 articles, local search. |

Live mode needs `MISTRAL_API_KEY`; `direct` legal mode needs PISTE credentials (`PISTE_CLIENT_ID`, `PISTE_CLIENT_SECRET`). The ECHR and company registry need nothing.

```bash
pnpm install            # adds @mistralai/mistralai to the lockfile
pnpm --filter @lexora/ai build && pnpm --filter @lexora/ai smoke
```

Not yet run against the live Légifrance/Judilibre APIs: the request formats follow the PISTE documentation; failures surface as `ok:false` audit entries, never as crashes.
