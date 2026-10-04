# Lexora Repository and Backend Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for sequential implementation, or `superpowers:subagent-driven-development` if the user selects delegated execution. Steps use checkbox syntax for tracking. This document plans the work; its creation does not start implementation or provision external services.

**Goal:** Set up a reproducible TypeScript monorepo and deliver the seeded WhatsApp message → case context → structured Mistral analysis → persisted lawyer alert flow before adding documents, voice endpoints, or legal MCP.

**Architecture:** Fastify accepts and durably records requests; a separate worker runs slow integrations. Both use shared Zod contracts, a Drizzle data service, and pg-boss jobs in the same Postgres database. Supabase supplies hosted Postgres and private object storage.

**Tech stack:** Node.js 24 LTS, TypeScript, pnpm, Fastify 5, Zod, Drizzle, `pg`, pg-boss, Mistral SDK, Twilio SDK, Supabase Storage SDK; ESLint, Prettier, Vitest, Docker, GitHub Actions.

**Spec:** [Backend design](../specs/2026-10-04-backend-design.md). Read it with this plan: it defines schema fields, limits, processing states, and failure behavior.

**Status:** Proposed plan, 2026-10-04. TypeScript is confirmed. Other defaults are concrete proposals for review. No dependencies have been installed, accounts created, or product code changed.

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

## Review focus

1. Duplicate webhooks and worker crashes must not lose acknowledged input or repeat an already recorded analysis. Covered in Tasks 3, 5, and 6.
2. Unknown phone numbers, multiple active cases, and mismatched case/conversation IDs must never expose another person's case. Covered in Tasks 2, 5, and 8.
3. Invalid AI output, provider outages, and unavailable legal sources must yield visible uncertainty and review work. Covered in Tasks 4, 6, and 9.
4. WhatsApp acceptance is not delivery; ambiguous sends and closed lawyer messaging windows must not be reported as successful alerts. Covered in Tasks 6 and 10.
5. Oversized, mislabeled, or unsafe remote media and out-of-order callbacks must be bounded and replay-safe. Covered in Tasks 7 and 6.

## Milestones and order

| Milestone | Tasks | Exit evidence |
| --- | --- | --- |
| M0: repository ready | 1–3 | Fresh clone builds, migrations and seed work, queued work survives restart |
| M1: text golden path | 4–6 | Fake-provider run passes; real Mistral result saved; lawyer receives a real sandbox alert |
| M2: documents | 7 | PDF/image stored privately, extracted, analyzed, and linked to the alert |
| M3: voice contract | 8 | A separate trusted voice service can complete the documented API flow |
| M4: legal context | 9, optional | Read-only MCP evidence enriches analysis; outage leaves triage usable |
| Demo deployment | 10, start at M1 | API and worker run in containers; migration, restart, delivery and rollback checks pass |

Create the minimal CI checks during Task 1 and extend them with each task. Deploy M1 before proceeding to optional integrations. A task is finished when its acceptance checks pass and its focused changes are committed; do not commit secrets or demo-generated files.

## Repository map

```text
apps/
  api/src/
    app.ts                   # Fastify factory for injection tests
    index.ts                 # env, listen, graceful shutdown
    auth.ts                  # internal service token and request context
    routes/{health,whatsapp,delivery,voice}.ts
  worker/src/
    index.ts                 # queue workers and graceful shutdown
    pipeline.ts              # inbound orchestration
    escalation.ts            # escalation policy and alert rendering
    documents.ts             # media ingestion and OCR orchestration
    outbound.ts              # persisted send lifecycle
    summary.ts               # conversation completion
    integrations/{twilio,storage}.ts
packages/
  shared/src/{domain,requests,config,index}.ts
  db/src/{client,schema,people,cases,conversations,messages,documents,analyses,escalations,queue,seed,index}.ts
  db/drizzle/                # reviewed generated SQL migrations
  db/drizzle.config.ts
  ai/src/{analyze,prompts,ocr,legal-context,index}.ts
tests/
  fixtures/                  # fictional inputs, output fixtures, small PDF/JPEG/PNG
  integration/               # actual Postgres and fake external providers
  e2e/                       # pipeline and HTTP contract checks
scripts/{demo,setup-storage,queue-migrate,inspect-jobs,reconcile-send}.ts
docs/{backend-api,development,deployment,demo-runbook}.md
.github/workflows/ci.yml
package.json, pnpm-workspace.yaml, pnpm-lock.yaml
tsconfig.base.json, tsconfig.json, vitest.config.ts
eslint.config.mjs, .prettierrc.json, .editorconfig
.env.example, .gitignore, .dockerignore, .node-version
Dockerfile, compose.yaml, README.md
```

Each workspace gets a `package.json` and `tsconfig.json`. Add files as their task needs them; do not create empty service layers. Keep tests beside simple modules (`*.test.ts`); use root integration tests for DB/process boundaries.

Dependency direction: `shared ← db`, `shared ← ai`, and all three are consumed by applications. Shared imports no database or provider SDKs. Worker-specific Twilio/Storage functions stay in the worker until another application needs them. API uses the Twilio SDK only for signature validation. Use `workspace:*`, explicit package exports, and compiled `dist` output so production imports behave like development imports.

## Configuration and commands

Validate configuration separately at each entrypoint; importing a schema must not require every provider secret. Never print connection strings or secrets on validation failure.

| Variable | Required when / meaning |
| --- | --- |
| `NODE_ENV`, `PORT`, `LOG_LEVEL` | Runtime defaults: `development`, `3000`, `info` |
| `APP_MODE` | `demo` or `production`; demo is allowlist-only |
| `DATABASE_URL` | API/worker application connection, direct or session pool |
| `MIGRATION_DATABASE_URL` | Deployment/local schema migration identity; never needed by normal request handlers |
| `PUBLIC_BASE_URL` | Live webhook origin; HTTPS outside local tests; used in signature reconstruction |
| `INTERNAL_API_TOKEN` | Trusted voice/demo server-to-server routes; long random secret |
| `DEMO_ALLOWED_NUMBERS` | Comma-separated E.164 values; empty list rejects all demo traffic |
| `DEMO_CLIENT_PHONE`, `DEMO_LAWYER_PHONE` | Explicit live-demo phone bindings; synthetic seed defaults cannot send externally |
| `AI_MODE`, `MESSAGING_MODE`, `STORAGE_MODE` | `fake` or `live`; default fake locally, production rejects fake |
| `MISTRAL_API_KEY`, `MISTRAL_ANALYSIS_MODEL` | Required for live analysis; select a structured-output-capable model available to the account and record its ID |
| `MISTRAL_OCR_MODEL` | Required only for live document extraction |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` | Required for live Twilio; sender uses `whatsapp:+…` |
| `TWILIO_ALERT_CONTENT_SID` | Approved alert template for lawyer messages outside the service window |
| `TWILIO_DOCUMENT_REQUEST_CONTENT_SID` | Approved document-request template outside the client's window |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Live storage only; private bucket name `case-documents` |
| `LEGAL_CONTEXT_MODE`, `LEGAL_MCP_URL`, `LEGAL_MCP_TOKEN` | `mock`, `disabled`, or `mcp`; URL/auth only when MCP is enabled |

`OPENAI_API_KEY` and `TWILIO_PHONE_NUMBER` belong to a future voice runtime, not these services. Document them in the voice handoff if needed; do not make them boot requirements. Put safe placeholders only in `.env.example`; ignore actual `.env` files while explicitly tracking the example.

Root commands to implement:

```bash
pnpm install --frozen-lockfile
docker compose up -d db
pnpm db:migrate                    # domain SQL, then pg-boss schema setup
pnpm db:seed                       # idempotent fictional seed
pnpm dev                           # initial build, shared watch, API + worker
pnpm check                         # lint, format check, typecheck
pnpm test                          # isolated unit tests, no credentials
pnpm test:integration              # disposable Postgres database
pnpm build                         # topological workspace compilation
pnpm demo:golden-path              # fake providers through the real pipeline
pnpm demo:golden-path --live        # explicit opt-in to real API usage/messages
```

The commands above are planned interfaces, not commands that work in the current repository. The eventual README must identify required processes/env, ports, clean shutdown, and how to reset only the demo database.

## Task 1: Reproducible workspace and API shell

**Files:** root configuration and README from the map; workspace manifests/tsconfigs; `apps/api/src/{app,index}.ts`, `routes/health.ts`; `packages/shared/src/config.ts`; `.github/workflows/ci.yml`.

**Produces:** `buildApp(deps): FastifyInstance`, `parseApiEnv(env): ApiConfig`, `parseWorkerEnv(env): WorkerConfig`, compiled workspace exports, and root commands.

- [ ] Pin Node 24's selected patch in `.node-version`, `engines`, CI, and Docker; pin a compatible pnpm release in `packageManager` and commit `pnpm-lock.yaml`. Use one root lockfile and no Nx/Turborepo.
- [ ] Configure ESM/NodeNext, strict checking, `noUncheckedIndexedAccess`, project references and package exports. Build dependency packages before applications. Watch compiled shared packages during development.
- [ ] Install runtime dependencies in the workspaces that use them, and ESLint/Prettier/TypeScript/tsx/Vitest at the root. Use compatible Fastify form-body and Swagger plugins; keep dependency versions reproducible. Configure `pnpm test` for colocated unit tests and `pnpm test:integration` for both root integration and e2e tests, forwarding optional filename filters.
- [ ] Implement environment parsing, a testable Fastify factory, JSON error responses `{error:{code,message,requestId}}`, redacted structured logs, and clean SIGTERM handling. `/health/live` returns `{status:'ok'}`; `/health/ready` checks DB once Task 2 lands, with a one-second timeout and 503 on failure.
- [ ] Add tests `config-fails-on-missing-database`, `fake-mode-needs-no-provider-keys`, `production-rejects-fakes`, and `health-live`. Verify missing keys fail startup without leaking values; `app.inject()` returns 200 for liveness.
- [ ] Run `pnpm check`, `pnpm test`, and `pnpm build`; all pass. CI runs the same with a frozen install. Commit `chore: initialize TypeScript backend workspace`.

## Task 2: Domain contracts, database, and seed

**Files:** `packages/shared/src/{domain,requests,index}.ts`; `packages/db/src/{client,schema,people,cases,conversations,messages,documents,analyses,escalations,seed,index}.ts`; Drizzle config/migrations; `compose.yaml`; `tests/integration/data.test.ts`.

**Produces:** schema-derived types; `normalizePhone(raw): string`; `findPersonByPhone(phone): Promise<Person|null>`; `getActiveCase(personId): Promise<{kind:'found';case:Case}|{kind:'none'}|{kind:'ambiguous'}>`; `getCaseContext(caseId): Promise<CaseContext>`; `getCaseMessages(caseId, cursor?): Promise<MessagePage>`; `getCaseDocuments(caseId): Promise<Document[]>`; `getDeadlines(caseId): Promise<Deadline[]>`.

- [ ] Write schema/phone tests before domain logic: missing/extra analysis fields fail; E.164 normalization is stable; ambiguous national numbers reject. IDs are UUIDs and API dates are ISO 8601.
- [ ] Implement the nine domain tables in the spec with foreign keys, unique constraints, and indexes. `CaseContext` includes the case, members, confirmed/unverified deadlines, ready-document references, and latest stored analysis; it excludes secrets and private object URLs.
- [ ] Add typed writes `saveMessage(tx, input): Promise<Message>`, `saveAnalysis(tx, input): Promise<Analysis>`, and `saveConversationSummary(tx, conversationId, summary, throughMessageId): Promise<void>`. Transaction types remain inside `db`; application-facing workflow helpers own transactions.
- [ ] Create and review SQL migrations. Set up local Postgres with a persistent named Docker volume and health check; match its major to the selected Supabase project's supported major at setup. Never use schema-push commands in deployed environments.
- [ ] Seed Sarah, John, their membership, one open case, previous messages, one explicitly fictional confirmed deadline, and two ready document text fixtures. Use stable IDs, a fixed clock in tests, and a next-day hearing time for live demos. Mark fixtures as synthetic; no real storage or outbound calls during seeding.
- [ ] Enforce routing outcomes and ownership: case lookup never picks among multiple open cases; a message cannot bind to another case's conversation. Query messages with stable ordering and paginated results (50 default, 100 maximum).
- [ ] Run `pnpm db:migrate` twice and `pnpm db:seed` twice on a fresh local database; second runs do not duplicate or destroy data. Run `pnpm test:integration -- data.test.ts`; assert unique provider IDs, one primary lawyer, ambiguity handling, and ownership rejection. Commit `feat: add domain contracts and seeded case storage`.

## Task 3: Durable work and transactional intake

**Files:** `packages/db/src/queue.ts`, `apps/worker/src/index.ts`, `scripts/{queue-migrate,inspect-jobs}.ts`, `tests/integration/queue.test.ts`.

**Consumes:** Task 2's writes and schema. **Produces:** `acceptInbound(input: InboundMessage): Promise<{messageId:string;duplicate:boolean}|{ignoredReason:string}>`; `enqueueAnalysis(input: AnalysisTrigger): Promise<{jobId:string}>`; queue handlers with shared discriminated payload schemas.

- [ ] Define job names/payloads: `process-inbound {messageId}`, `analyze-conversation {conversationId,triggerKey,throughMessageId}`, `process-document {documentId}`, `send-outbound {messageId}`, `complete-conversation {conversationId,throughMessageId}`. Store IDs only.
- [ ] Use pg-boss with a reviewed pinned version and its Drizzle transaction adapter. Install/upgrade the queue schema through a migration identity, not on every API startup. Create queues idempotently; restrict runtime credentials to required queue operations.
- [ ] Make `acceptInbound` atomically persist the message, media placeholders, and processing job. Uniqueness is the final guard against concurrent duplicates. A transaction failure leaves none of them behind.
- [ ] Configure bounded retries/timeouts per the spec, seven-day queue-result retention, a failed-job inspection command, structured failure records, and graceful worker shutdown. Start one worker replica with serial inbound handling; document this capacity limit before scaling. Use job expiration/heartbeat settings longer than the bounded handler runtime; a live handler must not overlap a redelivered attempt.
- [ ] Verify `rollback-removes-message-and-job`, `duplicate-delivery-queues-once`, and `restart-resumes-accepted-job` against Postgres, including a real worker process killed after acceptance. Example invariant: `expect([messages.length, jobs.length]).toEqual([1, 1])` after concurrent duplicate requests.
- [ ] Run `pnpm test:integration -- queue.test.ts`; all pass without provider credentials. Commit `feat: add transactional background jobs`.

## Task 4: Structured analysis and safe fallback

**Files:** `packages/ai/src/{analyze,prompts,legal-context,index}.ts`, `apps/worker/src/pipeline.ts`, `packages/ai/src/analyze.test.ts`, `tests/fixtures/analyses.json`.

**Consumes:** `CaseAnalysisSchema`, `CaseContext`, and Task 3 jobs. **Produces:** `analyzeConversation({caseContext,messages,latestMessage}): Promise<AnalysisOutcome>` where `AnalysisOutcome` is `{analysis:CaseAnalysis,status:'ok'|'fallback',model:string,promptVersion:string,schemaVersion:1}`.

- [ ] Write fixtures for urgent hearing, missing facts, benign update, injected instructions, malformed JSON, and provider timeout. Assert valid schema, bounded output, correct fallback metadata, and no claimed review of omitted documents.
- [ ] Implement explicit fake/live modes behind ordinary functions. The fake analyzes fixture inputs deterministically; live uses the configured Mistral model and custom structured output, then independently parses Zod.
- [ ] Build bounded context per the spec, excluding the trigger from prior messages and including it exactly once. Preserve message/document source IDs and truncation markers. Do not expose arbitrary DB/network tools to the model.
- [ ] Implement one schema-repair retry and timeout/failure fallback. Keep all SDK/job retry counts within the spec's budget. Persist provider/model/prompt provenance without putting raw private prompts in logs.
- [ ] Save analyses idempotently by `trigger_key`. If an analysis already exists when the job restarts, use that result instead of generating a second one.
- [ ] Run `pnpm test -- analyze.test.ts`; all deterministic fixtures pass. Record a separate live model check with the fictional urgent fixture; schema-valid output is mandatory, while semantic errors block selecting that model/prompt for the demo. Commit `feat: analyze case conversations with structured Mistral output`.

## Task 5: Signed WhatsApp text intake

**Files:** `apps/api/src/routes/whatsapp.ts`, `packages/shared/src/requests.ts`, `apps/worker/src/pipeline.ts`, `tests/integration/whatsapp.test.ts`.

**Consumes:** `acceptInbound` and `analyzeConversation`. **Produces:** `POST /webhooks/whatsapp`, provider-normalized `InboundMessage`, durable text processing.

- [ ] Parse Twilio's URL-encoded form with a 256 KiB body limit. Validate the signature before field normalization, using every form field and the exact configured external URL. Do not trust arbitrary forwarded-host headers or add a production signature-bypass switch.
- [ ] Validate Account SID, sender, Message SID, text length (10,000 characters), and declared media count. Preserve empty text for supported media messages. Reject malformed signed payloads with 400, invalid signatures with 403.
- [ ] Route only known, enrolled, allowlisted participants with one case. A lawyer's incoming greeting updates that recipient's WhatsApp window but does not trigger client-case analysis. Unknown/unroutable input returns empty 200 and a redacted reason, without storing its body or invoking AI.
- [ ] Commit the accepted client input and job, then return `application/xml` with `<Response/>`. Process no AI calls/downloads before acknowledgment. Duplicate input returns 200; DB/queue failure returns 503.
- [ ] Verify valid/invalid signatures, extra signed fields, reverse-proxy URL reconstruction, unknown phones, multiple cases, concurrent duplicates, and database failure. Example invariant: `expect(aiCallsBeforeWebhookResponse).toBe(0)`.
- [ ] Run `pnpm test:integration -- whatsapp.test.ts`; all pass. Commit `feat: accept signed WhatsApp messages durably`.

## Task 6: Lawyer escalation and first golden path

**Files:** `apps/worker/src/{escalation,outbound}.ts`, `integrations/twilio.ts`, `apps/api/src/routes/delivery.ts`, `scripts/{demo,reconcile-send}.ts`, `tests/e2e/golden-path.test.ts`, `tests/integration/delivery.test.ts`, `docs/demo-runbook.md`.

**Consumes:** saved analysis, assigned lawyer, recipient window timestamps. **Produces:** `escalateToLawyer(caseId, analysisId): Promise<Escalation>`; `sendOutbound(messageId): Promise<void>`; signed `POST /webhooks/twilio/status?messageId=…`; persisted outcomes.

- [ ] Implement the spec's escalation policy. Atomically create escalation, outbound message, and send job with analysis persistence; keep one escalation per analysis. No lawyer creates `blocked_no_lawyer` and an operational alert. Use deterministic alert copy, capped at 1,200 characters, without another model call.
- [ ] Define escalation states `pending`, `sending`, `accepted`, `delivered`, `failed`, `delivery_unknown`, `blocked_no_lawyer`, `blocked_template_required`, `simulated`; track outbound message state separately and map it consistently. Fake send records `simulated`, never `delivered`.
- [ ] Check the lawyer's own window before live sending. Use free text within it, an approved template outside it, or record a blocked result. Apply the same recipient checks to outbound messages as inbound; seeded synthetic phones must never reach Twilio.
- [ ] Persist `sending` before sending; store the response SID on acceptance. On uncertain acceptance, stop automated resend and surface `delivery_unknown`. A restart with a stale `sending` record enters reconciliation rather than issuing another HTTP call.
- [ ] Validate callback signatures and correlation IDs; check SID consistency when known; make duplicate/out-of-order status changes monotonic. Record callbacks that arrive before the send response. A delivered result cannot later become merely accepted.
- [ ] Add `reconcile-send` to inspect Twilio state and record an operator decision for uncertain sends. An explicit resend gets a new attempt record/reference in the outbound message metadata; never quietly reset an old success to pending.
- [ ] Test one analysis/one escalation for duplicate input, missing lawyer, closed window, callback replay, callback before send response, crash after send acceptance, permanent rejection, and timeout. Assert ambiguous sends cause zero automatic retries.
- [ ] Run `pnpm demo:golden-path` and `pnpm test:integration`; demonstrate message → Sarah → case → `HIGH` fixture analysis → simulated alert and all persisted IDs. This is the credential-free M1 check.
- [ ] Run the explicit live check with allowlisted sandbox phones: both participants join and send a greeting; Sarah sends the fictional hearing message; inspect the real saved Mistral result; John receives the alert; verify a delivery callback or clearly record the provider's available status. A fake run alone does not complete live M1.
- [ ] Commit `feat: deliver and track lawyer escalations`. Begin Task 10's container deployment now; do not wait for OCR/MCP.

## Task 7: Private documents and extraction

**Files:** `apps/worker/src/documents.ts`, `integrations/storage.ts`, `packages/ai/src/ocr.ts`, `packages/db/src/documents.ts`, `scripts/setup-storage.ts`, `tests/integration/documents.test.ts`, fixtures.

**Consumes:** document placeholders from intake. **Produces:** `processDocument(documentId): Promise<void>`; `extractDocument({bytes,mimeType}): Promise<{text:string,metadata:DocumentMetadata}>`; a document-derived analysis trigger.

- [ ] Add storage setup/check command creating `case-documents` as private, with matching size/MIME restrictions. Test fake storage by default; run a separate hosted upload/private-download smoke check.
- [ ] Implement streamed bounded Twilio downloads; validate HTTPS host/account/media identity, public destination resolution and every redirect, and never send credentials across hosts. Verify magic bytes; allow only PDF/JPEG/PNG, 10 MiB/file, five attachments/message. Reject unsupported media visibly without processing it as text.
- [ ] Save under `{caseId}/{documentId}/original`, then persist checksum and status. On restart, reconcile the deterministic key and metadata before uploading again. Preserve a failed row and reason when upload or OCR fails.
- [ ] Call Mistral OCR with a 60-second timeout; never make the bucket public. If an expiring URL is used, issue it only for the required processing window and do not log it. Validate metadata fields `{documentType,summary,dateMentions:[{text,isoDate|null,sourcePage}]}`.
- [ ] Store extracted text and source-linked metadata. AI date mentions remain unverified; they do not automatically become confirmed deadlines. Queue reanalysis with trigger `document:{id}:ready:v1`; failures queue a review-required result. Do not claim the initial text analysis included an unfinished attachment.
- [ ] Test PDF/JPEG/PNG success, empty/corrupt/encrypted file failures, wrong MIME, stream over limit, unsafe redirects, duplicate jobs, upload/DB interruption, and OCR timeout. Verify no public object URL and no duplicate document row.
- [ ] Run `pnpm test:integration -- documents.test.ts`, then a live fictional-document smoke check. Commit `feat: ingest private case documents and extract text`.

## Task 8: Voice-facing API and completion

**Files:** `apps/api/src/{auth.ts,routes/voice.ts}`, `packages/shared/src/requests.ts`, `apps/worker/src/summary.ts`, `docs/backend-api.md`, `tests/e2e/voice-api.test.ts`.

**Consumes:** data services and durable jobs. **Produces:** the following versioned contracts, shared Zod schemas, and generated OpenAPI. Routes are relative to `/v1` and require a trusted server token.

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /cases/resolve` | `{phone}` | 200 `{personId,caseId}`; 404 absent; 409 ambiguous |
| `POST /conversations` | `{caseId,personId,channel:'voice',externalSessionId}` | 201 `{conversationId}`; duplicate same session returns original |
| `POST /conversations/:id/messages` | `{externalMessageId,role:'client'|'assistant',text,occurredAt}` | 201 `{messageId}` or 200 existing; no automatic voice-turn analysis |
| `POST /conversations/:id/analyze` | `{throughMessageId}` plus idempotency key | 202 `{jobId}` |
| `GET /jobs/:id` | — | 200 `{status,resultId?,errorCode?}` |
| `GET /analyses/:id` | — | 200 `{id,status,analysis}` |
| `POST /cases/:id/request-document` | `{conversationId,documentNames:string[]}` plus idempotency key | 202 `{jobId,messageId}` |
| `POST /conversations/:id/complete` | `{throughMessageId}` plus idempotency key | 202 `{jobId}`; already complete returns stored result |
| `GET /conversations/:id` | — | 200 `{id,status,summary,summaryThroughMessageId}` |

Use POST lookup to keep phone numbers out of URL/access logs. This deliberately replaces the brief's example `GET /cases/by-phone/:phone`. Publish the contract early for the voice engineer; implementation follows M1.

- [ ] Apply bearer auth to all internal routes and reject unauthorized requests before data reads. Case membership and conversation bindings must agree even for a trusted caller. Document that the voice service, not this lookup, verifies caller identity.
- [ ] Scope idempotency keys by authenticated integration + route + resource; store key and payload hash in DB-backed request records (add migration `api_requests`). Same key/body returns original response; same key/different body returns 409; concurrent identical requests create one effect.
- [ ] Implement routes with 400 validation errors, 401 auth failures, 404 unavailable resources, 409 state/idempotency conflicts, 429 limits, and 503 dependency failures. Restrict OpenAPI/docs to internal/local access.
- [ ] Document requests create persisted outbound messages/jobs and use the same WhatsApp window/template/send lifecycle as escalation. A request records its names and delivery state without pretending documents have arrived.
- [ ] Completion atomically marks `completing` with a fixed message cutoff, then generates/saves a concise source-based summary and marks `complete`. Further appends return 409; callers open a new conversation. Retry resumes the same cutoff; failure leaves a visible failed job and permits explicit retry. Summary failure must not erase already stored messages/analysis.
- [ ] Test a full voice session, duplicate messages/requests, key/body conflict, invalid membership, unknown IDs, completion racing with append, document request delivery, and polling failed jobs. Assert completion summary cutoff matches the final accepted message.
- [ ] Run `pnpm test:integration -- voice-api.test.ts` with its documented DB setup and `pnpm build`; export OpenAPI and provide sample curl requests with placeholder tokens. Commit `feat: expose versioned voice integration endpoints`.

## Task 9: Optional legal MCP adapter

**Files:** `packages/ai/src/legal-context.ts`, its tests, `docs/development.md`.

**Produces:** `searchLegalContext({jurisdiction,issue}): Promise<{status:'ok'|'unavailable'|'mock',sources:LegalSource[]}>`; `LegalSource` is `{title,url,jurisdiction,excerpt,retrievedAt}`.

- [ ] Keep fixture/mock behavior until M1–M3 work. Inspect the selected MCP server's actual tools, authentication, transport, and response schema before mapping one allowlisted read-only search tool; `LEGAL_MCP_URL` alone is not a complete server contract.
- [ ] Use the official MCP client SDK appropriate to that server; enforce eight-second timeout, five-result/10,000-character cap, HTTPS URL validation, configured credentials, and explicit jurisdiction matching. Treat retrieved text as untrusted context.
- [ ] Store source references with analysis provenance. Label mock/unavailable results; never manufacture citations or turn missing legal context into a definitive legal claim.
- [ ] Verify timeout, bad credentials, invalid schema, prompt injection, wrong jurisdiction, oversized results, and no-results behavior. `expect(result.status).toBe('unavailable')` on provider failure; base triage still runs.
- [ ] Run the adapter tests and one read-only smoke query against the actual selected server. Commit `feat: add optional legal context search` only if a real server is available; otherwise finish the tested mock boundary and mark live MCP as externally blocked, not implemented.

## Task 10: Containers, CI, operations, and handoff

**Files:** `Dockerfile`, `.dockerignore`, `compose.yaml`, `.github/workflows/ci.yml`, `docs/{development,deployment,demo-runbook}.md`, `README.md`.

**Produces:** one immutable image with separate API/worker commands, repeatable migration/release steps, and a runnable demo runbook.

- [ ] Create a multi-stage non-root image. Build from the committed lockfile, include required workspace `dist` exports and production dependencies, exclude secrets/fixtures not needed at runtime and Python code. Verify both entrypoints inside the built image.
- [ ] Configure Compose API/worker services plus local DB; inject environment explicitly and wait for database readiness. Graceful worker termination stops accepting jobs and lets active work finish within a bounded grace period.
- [ ] Extend CI with a disposable Postgres service: migrate from empty, seed twice, run integration/golden-path tests, and build the image. No Mistral/Twilio/Supabase credentials in ordinary PR checks. Add separately invoked live smoke instructions rather than sending messages on every push.
- [ ] Provision the selected demo Supabase project, private bucket, Mistral credentials and Twilio sandbox during execution. Record owner/region and secret locations without secret values. Choose a container host that runs an always-on worker and HTTPS API; no host is assumed in this plan.
- [ ] Configure least-privilege DB runtime identities and a separate migration identity; disable unneeded public Data API access or deny anonymous/authenticated table access. Backend DB credentials are not protected by end-user RLS automatically. Verify storage remains inaccessible without authorization.
- [ ] Release in order: migration job → API/worker with same image revision → readiness and worker heartbeat → synthetic end-to-end smoke → Twilio webhook activation. Do not expose internal routes through browser-held service tokens. Keep previous image available; use additive migrations so rollback does not need to delete data.
- [ ] Log request/job/case/message/analysis/escalation IDs and provider error codes, excluding message bodies, phone numbers, tokens and document URLs. Track queue age, failures, analysis latency, blocked alerts, unknown sends and delivery failures. Persist/check a worker heartbeat; a healthy API alone does not prove processing is alive.
- [ ] Verify: fresh-clone startup, container restart after webhook acceptance, invalid signature rejection, DB outage/readiness failure, worker outage visibility, Mistral failure fallback, blocked-template visibility, one successful lawyer delivery, private document access, and rollback to the previous image.
- [ ] Document failure recovery: inspect/retry jobs, reconcile uncertain sends, replace expired webhook/tunnel URL, reset synthetic demo fixtures, and rotate credentials. Avoid retry commands that can send duplicate alerts without inspection.
- [ ] Commit `chore: package and document backend deployment`. Record exact commands and evidence for M0–M3 and whether M4 is live, mocked, or disabled.

## Definition of done and deferred scope

Repository setup is done when a fresh clone can install, migrate, seed, check, build, run both processes, and pass the credential-free golden path using documented commands. Backend M1 is done when the real seeded message is analyzed by Mistral, stored, and received by the lawyer with traceable delivery evidence; external account limitations must be reported separately.

The complete core backend additionally handles private PDF/image ingestion, recoverable failures, and the documented voice API. Legal MCP is optional and depends on a selected server. Before using real client data, separately complete user authentication/authorization, participant consent/onboarding, retention/deletion, provider data-handling decisions, and a restore drill. The synthetic single-firm demo is not a claim of production readiness.

Defer pgvector, semantic retrieval, Redis, Kubernetes, multi-firm tenancy, frontend/dashboard, audio streaming, WhatsApp voice-note transcription, billing, and generalized agent frameworks. Add them only against a demonstrated requirement after the core flow works.

## Suggested review points

The plan is ready to implement once its proposed defaults are accepted. The choices that matter most are the single-firm demo scope, pg-boss for durable jobs, internal-only voice integration, fixture jurisdiction/language, and the deployment account/host to use. None prevents preparing or reviewing this plan; account-specific values are supplied when their integration task begins.

Default execution recommendation: work through the tasks sequentially in this chat, completing M1 and deploying it before Tasks 7–9. This keeps the shared contracts and delivery behavior easy to verify as they evolve.
