# Lexora TypeScript backend design

Status: proposed design accompanying the requested implementation plan. No backend implementation or external provisioning has been performed.

## Goal and scope

Build a TypeScript backend for legal intake that resolves a known client to a case, collects messages and documents, produces structured triage, and alerts the assigned lawyer. The first milestone is a seeded text message flowing through real Mistral analysis into a persisted WhatsApp escalation. Deterministic provider substitutes must also make the same pipeline demonstrable without credentials.

The user selected TypeScript on 2026-10-04. The existing `emmanuel/` Python prototype is outside this work: no migration, reuse requirement, modification, or deletion. The supplied plan is the starting brief; the decisions below fill its implementation gaps.

### Proposed defaults

- One firm and explicitly enrolled demo participants. Multi-firm tenancy and public self-service onboarding are later work.
- Sarah Miller and John Smith remain fictional fixture names. Jurisdiction, language, and time zone are explicit case fields; the demo uses `FR`, `en`, and `Europe/Paris`. These are replaceable fixture values, not inferred from a phone number.
- Use a fictional criminal-proceedings case, matching the supplied example. Do not encode legal deadline calculations or jurisdiction-specific advice.
- The system prepares information for a lawyer. Model recommendations never execute legal actions or create confirmed deadlines automatically.
- Build the API and worker as two processes from one monorepo, with one Postgres database and a private document bucket.

## Architecture choice

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| API + worker + Postgres-backed jobs | Durable work without another hosted service | Selected |
| API with in-process background promises | Fewer moving parts, but acknowledged messages can be lost on restart | Reject for webhook processing |
| API + worker + Redis/BullMQ | Useful at larger scale, adds infrastructure to the first demo | Defer |

Use Node.js 24 LTS, TypeScript with strict checking, pnpm workspaces, Fastify 5, Zod, Drizzle with the `pg` driver, and pg-boss. Pin exact compatible package versions and the Node patch version when scaffolding; commit the lockfile. Node 24 and Fastify 5 are compatible choices according to the [Node release schedule](https://nodejs.org/en/about/previous-releases) and [Fastify requirements](https://fastify.dev/docs/v5.10.x/Guides/Migration-Guide-V5/).

`apps/api` verifies requests, authorizes access, and commits input plus jobs. `apps/worker` performs analysis, document processing, summaries, and outbound delivery. `packages/shared` owns schemas and configuration parsing; `packages/db` owns persistence and queue integration; `packages/ai` owns Mistral and the later legal-context adapter. Applications do not import each other.

Use pg-boss's existing Drizzle transaction adapter to atomically enqueue work with domain writes. Keep its tables in its own schema; do not build a second queue implementation. See [pg-boss transaction adapters](https://pgboss.io/api/adapters).

## Global constraints

- TypeScript only for the new backend; leave `emmanuel/` untouched.
- Node.js 24 LTS; Fastify 5; pnpm workspaces; strict TypeScript; ESM.
- PostgreSQL is the source of truth; domain SQL is confined to `packages/db`.
- Validate external input and AI output with Zod; derive TypeScript types from schemas.
- Acknowledge accepted webhooks only after committing input and durable work together.
- Keep all document objects private and all provider secrets on the server.
- Only explicitly allowlisted, enrolled demo participants can send or receive demo traffic.
- Automated checks use fake providers; live-provider checks are separately invoked.
- No OCR, MCP, vector search, frontend, or Realtime implementation before the text golden path passes.

## Domain and persistence

All domain IDs are UUIDs. Store instants as `timestamptz`, serialize ISO 8601, and retain the case's IANA time zone for display. Normalize phone numbers to E.164 after removing a channel prefix; require a country code rather than guessing a region.

| Table | Required data and constraints |
| --- | --- |
| `people` | `id`, `display_name`, unique `phone_e164`, `role` (`client` or `lawyer`), `enrolled_at`, `last_whatsapp_inbound_at`, timestamps |
| `cases` | `id`, `title`, `status` (`open`, `closed`), `jurisdiction`, `language`, `timezone`, timestamps |
| `case_members` | `case_id`, `person_id`, member `role`, `is_primary`; composite primary key; one primary lawyer per case via a partial unique index |
| `conversations` | `id`, `case_id`, `person_id`, `channel` (`whatsapp`, `voice`), optional unique provider session key, `status` (`open`, `completing`, `complete`), `summary`, `summary_through_message_id`, timestamps; one open WhatsApp conversation per person/case |
| `messages` | `id`, `case_id`, `conversation_id`, nullable `person_id` for system output, `direction`, `kind`, `text`, optional `provider`, `provider_message_id`, optional scoped `idempotency_key`, `delivery_status`, `metadata` JSONB for outbound attempt history, timestamps; unique provider/message ID when present |
| `documents` | `id`, `case_id`, `message_id`, `media_index`, private `storage_key`, `mime_type`, `byte_size`, `sha256`, `status`, `extracted_text`, `metadata` JSONB, `error_code`, timestamps; unique message/media index |
| `deadlines` | `id`, `case_id`, `title`, `due_at`, `timezone`, `source_document_id`, `source_message_id`, `verification_status` (`unverified`, `confirmed`); dates from AI remain unverified |
| `analyses` | `id`, `case_id`, `conversation_id`, `trigger_key` unique, `result` JSONB, `status` (`ok`, `fallback`), `model`, `prompt_version`, `schema_version`, `context_message_ids`, `context_document_ids`, `created_at` |
| `escalations` | `id`, `case_id`, `analysis_id`, nullable `lawyer_id`, nullable `outbound_message_id`, `status`, `reason`, `provider_message_id`, `error_code`, timestamps; unique `analysis_id` |

Add foreign keys and indexes on all case-based reads, message chronology `(conversation_id, created_at, id)`, and deadline dates. Enforce matching case/conversation/message ownership with composite constraints where possible and transactional checks elsewhere. Deleting a person must not silently cascade through case history.

When voice APIs are added, add `api_requests`: integration identity, route, resource ID, idempotency key, canonical request hash, response status/body, and timestamps; unique on the first four fields. Commit the request record and resulting domain/job writes together. Retain these records for the demo's lifetime. Preserve queue results for seven days so job polling can distinguish completed and failed work; return 404 once a job has expired. Domain analyses and delivery records remain the durable audit source.

Phone lookup is routing, not authentication. Zero active cases returns a typed absence; multiple active cases returns an ambiguity result. Never select the newest case arbitrarily. Unknown or ambiguous WhatsApp input receives an acknowledgment without case processing or a case-data response; log only a redacted routing reason.

## Shared contracts

Preserve the brief's `CaseAnalysis`: `issue: string`, `urgency: LOW | MEDIUM | HIGH | CRITICAL`, `urgencyReason: string`, `requiresLawyer: boolean`, `missingInformation: string[]`, `requestedDocuments: string[]`, `recommendedActions: string[]`.

`CaseAnalysisSchema` is strict: required keys, no additional keys; nonempty issue/reason at most 2,000 characters; each list at most 10 strings of at most 500 characters. Keep execution metadata in `analyses`, outside this public result. A structurally valid result is still a model assessment, not a verified legal conclusion.

An analysis request supplies a bounded case context, messages preceding the trigger, and the latest message exactly once. Context includes up to 30 preceding messages and five ready documents, at most 12,000 characters per document and 80,000 total input characters. Record omissions; never claim omitted or failed documents were reviewed.

## Processing and reliability

1. Verify the Twilio signature over the configured public URL and complete form parameter set before normalizing or filtering fields. Reject invalid signatures with 403. Twilio recommends its SDK validator; see [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
2. Resolve an allowlisted, enrolled participant and one case. Commit message/document placeholders and `process-inbound` job atomically. Return 200 with empty TwiML; return 503 if persistence fails. Duplicate provider message IDs return the same acknowledgment and create no new work.
3. Worker reads a deterministic context snapshot, calls Mistral, validates the result, and stores it. Custom structured output plus independent Zod validation is preferred over JSON mode alone; see [Mistral structured output](https://docs.mistral.ai/studio/conversations/structured-output/custom).
4. Retry malformed output once. On a second schema failure, timeout, or exhausted transient retries, save a `fallback` result: unknown urgency is represented conservatively as `HIGH`, `requiresLawyer=true`, and the reason explicitly says automated assessment failed. Do not fabricate a finding.
5. Escalate when urgency is `HIGH`/`CRITICAL`, `requiresLawyer=true`, or the analysis is a fallback. Create the escalation and outbound job in the analysis transaction. No assigned lawyer yields `blocked_no_lawyer` and a visible operational failure.
6. Send a deterministic concise alert with case ID, issue, urgency reason, reviewed-document count, and next step. Store the provider SID and reconcile signed status callbacks. Accepted by Twilio is not delivered.

Jobs carry IDs, not full documents or transcripts. Start with one worker replica and sequential inbound processing; do not rely on enqueue order for context consistency. An analysis trigger key identifies its input event/revision. Analyze text immediately if present, then each successfully extracted document with a distinct trigger; media-only messages wait for extraction, and extraction failure generates a review-required result.

Job retries are bounded: three total attempts, exponential delay starting at five seconds. Provider calls have explicit abort timeouts: 30 seconds for analysis, 60 seconds for OCR, 15 seconds for outbound requests. A schema repair consumes the second of at most two model calls in a successful analysis attempt. Disable hidden SDK retries; cap total analysis calls at six per job. Completed analysis trigger keys short-circuit reprocessing. Process small files independently; never hold a DB transaction over a provider call.

Outbound effects cannot be made exactly-once by a database transaction. Persist `sending` before the HTTP call. If a timeout or crash leaves acceptance uncertain, set/reconcile `delivery_unknown` and require operator inspection before resending. Never blindly replay an ambiguous send. Retrying a known pre-send failure is safe. Callback URLs include the persisted outbound message ID so early callbacks can correlate before the response SID is saved. Duplicate and late callbacks must not regress a terminal delivery state.

Each recipient has their own WhatsApp window: a client message does not open the lawyer's window. For the live demo, enroll both phones in the Twilio sandbox and have both send a message shortly before the run. Outside the 24-hour window, use an approved template, or record `blocked_template_required`. See [Twilio WhatsApp messaging rules](https://www.twilio.com/docs/whatsapp/api).

## Documents, voice, and legal context

Accept PDF, JPEG, and PNG initially: maximum 10 MiB per file and five attachments per message. Verify detected bytes against MIME type, bound streamed downloads, and reject unsafe URLs/redirects. Fetch Twilio media only through validated provider URLs; never forward provider credentials to a redirect host. Use UUID-based private object keys. Supabase supports private buckets and expiring signed downloads; see [storage access](https://supabase.com/docs/guides/storage/buckets/fundamentals).

Document states: `pending → stored → extracting → ready`; terminal `rejected` or `failed` retain a reason. Uploads and DB writes are not atomic: deterministic object keys and restart-aware upserts make retries recoverable. Mistral OCR yields text; a separate validated metadata result identifies document type, summary, and date mentions. Preserve source references and uncertainty. Store extracted text directly; no chunking or embeddings. See [Mistral OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr).

Expose authenticated server-to-server voice APIs for case lookup, conversation creation, message append, analysis, document requests, status polling, and completion. Do not implement audio streaming or assume caller ID proves identity. The trusted voice service must verify/enroll the caller before binding a conversation to a person. A single shared integration token is a demo-only trust boundary, not end-user authorization.

`searchLegalContext({jurisdiction, issue})` initially returns explicitly labeled fixture context. Later connect the configured read-only MCP service with an eight-second timeout, at most five results and 10,000 returned characters. Return source title, URL, jurisdiction, and retrieval timestamp. Provider unavailability must not prevent triage. No write tools or model-selected case IDs; case reads remain scoped by application code.

## Delivery boundaries

Use local Postgres in Docker for default development and CI, then hosted Supabase Postgres and private Storage for integration. Use a direct/session connection for the persistent worker and migrations; verify TLS and budget connection pools. Supabase distinguishes session and transaction pooling; see its [Drizzle connection guide](https://supabase.com/docs/guides/database/drizzle).

Ship one API container and one worker container from the same image, plus a one-shot migration command. Maintain independent dev/demo and production secrets/databases. Start with a synthetic-data demo; real-client launch separately requires end-user authentication/authorization, retention/deletion and provider data-processing decisions, and a tested restore procedure.

Milestones: M0 reproducible workspace; M1 text → analysis → lawyer alert; M2 documents; M3 voice API; M4 optional legal MCP. CI, logging, and deployment smoke checks accompany each milestone. There is no dashboard, Redis, vector store, real-time audio implementation, or multi-agent AI orchestration in this scope.
