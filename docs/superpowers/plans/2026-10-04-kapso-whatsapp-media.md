# Kapso WhatsApp Text and Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive WhatsApp text, image, and PDF messages through Kapso, pass a normalized message and any downloaded file bytes to the backend's Mistral handler, and send its text response back through WhatsApp.

**Architecture:** Fastify receives one unbuffered `whatsapp.message.received` webhook, verifies its HMAC signature, acknowledges it immediately, then processes it in the existing API process. A small Kapso adapter parses messages, downloads short-lived media, and sends text replies; an injected backend handler is the only boundary with Mistral. No database, worker, queue, templates, delivery-status tracking, or permanent file storage is added on this branch.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Zod, built-in `fetch`, built-in `node:crypto`, Kapso REST API v24.0

**Spec:** In-chat scope approved on 2026-10-04; no separate spec was requested for this hackathon branch.

## Global Constraints

- TypeScript only; ignore the Python application.
- Support inbound text, JPEG/PNG/WebP images, and PDFs only.
- Keep downloaded media in memory only and cap each file at 10 MB.
- The backend/Mistral boundary receives bytes plus MIME type; Mistral prompting and database persistence are outside this branch.
- Use built-in platform APIs and existing dependencies; do not add a Kapso SDK, queue, storage layer, or test framework.
- Subscribe only to `whatsapp.message.received`, with webhook buffering disabled.
- Keep a bounded in-memory set of Kapso `X-Idempotency-Key` values, falling back to `message.id` when the header is absent, for demo-time duplicate protection.

## Review Focus

- Invalid or missing `X-Webhook-Signature` must return `401` without invoking the backend handler.
- A repeated `X-Idempotency-Key` must return `200` without processing the message twice during the same process lifetime.
- Unsupported message types and non-PDF documents must not reach Mistral and must receive a short explanatory reply.
- Media over 10 MB or a failed/expired download must not reach Mistral and must receive a retry message.
- A backend/Mistral failure must be logged and converted into a generic WhatsApp error reply.

---

### Task 1: Configure Kapso and define the backend contract

**Files:**
- Modify: `.env.example`
- Modify: `packages/shared/src/config.ts`
- Create: `apps/api/src/whatsapp/types.ts`

**Interfaces:**
- Produces: `ApiConfig` fields `kapsoApiKey`, `kapsoPhoneNumberId`, and `kapsoWebhookSecret`.
- Produces: `IncomingWhatsAppMessage`, `DownloadedMedia`, and `IncomingMessageHandler`.

- [ ] **Step 1: Replace the Twilio example variables**

Add `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, and `KAPSO_WEBHOOK_SECRET` to `.env.example`; remove the Twilio variables. Keep `DATABASE_URL` and `MISTRAL_API_KEY` because other branches use them.

- [ ] **Step 2: Split API and worker environment validation**

Make `parseApiEnv()` require and return the three Kapso values. Keep `parseWorkerEnv()` independent of Kapso so starting the worker does not require WhatsApp credentials.

- [ ] **Step 3: Define the transport contract**

Create these types in `apps/api/src/whatsapp/types.ts`:

```ts
export type DownloadedMedia = {
  bytes: Buffer;
  mimeType: string;
  filename?: string;
};

export type IncomingWhatsAppMessage = {
  providerMessageId: string;
  conversationId: string;
  from: string;
  kind: "text" | "image" | "pdf" | "unsupported";
  text?: string;
  media?: DownloadedMedia;
};

export type IncomingMessageHandler = (
  message: IncomingWhatsAppMessage,
) => Promise<string | undefined>;
```

The future Mistral handler consumes this interface directly: image/PDF bytes, MIME type, optional filename/caption, sender, and conversation identifiers.

- [ ] **Step 4: Verify configuration and types**

Run: `pnpm typecheck`

Expected: exit code `0`.

- [ ] **Step 5: Commit**

```bash
git add .env.example packages/shared/src/config.ts apps/api/src/whatsapp/types.ts
git commit -m "feat: configure Kapso WhatsApp transport"
```

### Task 2: Implement the minimal Kapso adapter

**Files:**
- Create: `apps/api/src/whatsapp/kapso.ts`
- Create: `apps/api/test/kapso.test.mjs`
- Modify: `apps/api/package.json`

**Interfaces:**
- Consumes: Kapso credentials from Task 1.
- Produces: `verifyKapsoSignature(rawBody, signature, secret): boolean`.
- Produces: `parseKapsoMessage(payload): ParsedKapsoMessage | null` where parsed messages contain provider ID, conversation ID, sender, kind, text/caption, media ID, MIME type, and filename.
- Produces: `createKapsoClient(config, fetchImpl?)` with `downloadMedia(mediaId, expectedMimeType?, filename?)` and `sendText(to, body)`.

- [ ] **Step 1: Add dependency-free adapter checks**

Use Node's built-in test runner against compiled output. Cover: valid and invalid HMAC SHA-256 signatures; parsing text, image, and PDF fixtures; rejecting another document MIME type; a mocked media response over 10 MB; and the exact outbound text request body. Add an `apps/api` test script that builds and runs this single `.mjs` file.

- [ ] **Step 2: Verify that the checks initially fail**

Run: `pnpm --filter @lexora/api test`

Expected: failure because `dist/whatsapp/kapso.js` does not exist.

- [ ] **Step 3: Implement signature verification**

Calculate an HMAC SHA-256 hex digest over the raw request bytes using `node:crypto`. Read `X-Webhook-Signature` as a string, check buffer lengths first, and compare with `timingSafeEqual`.

- [ ] **Step 4: Implement v2 webhook parsing**

Accept only an unbuffered `whatsapp.message.received` payload. Map:

- `message.id` to `providerMessageId`
- `conversation.id` to `conversationId`
- `message.from`, falling back to `conversation.phone_number`, to `from`
- `message.text.body` to text
- `message.image.id` plus caption/MIME metadata to image
- `message.document.id` to PDF only

Return `unsupported` for any other WhatsApp type and `null` for malformed payloads.

- [ ] **Step 5: Implement media download**

Call `GET https://api.kapso.ai/meta/whatsapp/v24.0/{media_id}?phone_number_id={phone_number_id}` with `X-API-Key`, then immediately fetch the returned `download_url`. Reject missing MIME information, unsupported MIME types, and files over 10 MB before returning `DownloadedMedia`. Do not write the file to disk.

- [ ] **Step 6: Implement text sending**

Call `POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages` with `X-API-Key` and the WhatsApp text payload. Return the first `wamid` from the response and throw a concise error for non-2xx responses.

- [ ] **Step 7: Run the adapter checks**

Run: `pnpm --filter @lexora/api test`

Expected: all checks pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/whatsapp/kapso.ts apps/api/test/kapso.test.mjs apps/api/package.json
git commit -m "feat: add Kapso text and media adapter"
```

### Task 3: Add the webhook route and backend handoff

**Files:**
- Create: `apps/api/src/routes/kapso-webhook.ts`
- Create: `apps/api/src/incoming-message-handler.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/kapso.test.mjs`

**Interfaces:**
- Consumes: `IncomingMessageHandler` and the Kapso adapter from Tasks 1-2.
- Produces: `registerKapsoWebhook(app, options): Promise<void>`.
- Produces: `handleIncomingMessage(message): Promise<string | undefined>` as the single replacement point for the backend/Mistral implementation.

- [ ] **Step 1: Add route checks**

Cover `401` for an invalid signature, `200` for a valid text event, one handler call for duplicate idempotency keys, image/PDF bytes reaching the handler, unsupported media bypassing the handler, and a handler exception producing the generic fallback reply through a mocked Kapso client.

- [ ] **Step 2: Register a raw-body content parser for this route**

Register `registerKapsoWebhook` as an encapsulated Fastify plugin. Inside that plugin, install an `application/json` parser with `parseAs: "buffer"` so only the Kapso route receives a `Buffer`; preserve those exact bytes for signature verification and parse JSON only afterward. Do not re-serialize a parsed body before checking the signature.

- [ ] **Step 3: Implement `POST /webhooks/kapso`**

Require `X-Webhook-Event: whatsapp.message.received`, verify the signature, check `phone_number_id` matches configuration, and deduplicate using `X-Idempotency-Key` or `message.id` as its fallback. Bound the set to the latest 1,000 keys. Send `200` immediately, then process the message asynchronously in the same Node process.

- [ ] **Step 4: Process text and media**

For text, call the handler directly. For an image or PDF, download it first and attach the bytes. Send the handler's returned string to the original sender. For unsupported content, download failure, oversize media, or handler failure, send a short fixed fallback message and log the cause.

- [ ] **Step 5: Add the backend/Mistral seam**

Export `handleIncomingMessage()` from `apps/api/src/incoming-message-handler.ts`. Initially log the normalized message metadata and return `"Thanks, we received your message."`; do not log file bytes and do not access a database. The colleague implementing Mistral replaces only this function body and returns the text that should be sent to the WhatsApp user.

- [ ] **Step 6: Wire the route into the API**

Create the Kapso client from `parseApiEnv(process.env)`, register the route, and inject `handleIncomingMessage`. Leave `/health` unchanged.

- [ ] **Step 7: Run local verification**

Run: `pnpm --filter @lexora/api test && pnpm typecheck`

Expected: all checks pass and typecheck exits `0`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/kapso-webhook.ts apps/api/src/incoming-message-handler.ts apps/api/src/index.ts apps/api/test/kapso.test.mjs
git commit -m "feat: receive Kapso WhatsApp messages"
```

### Task 4: Configure Kapso and prove the golden path

**Files:**
- Modify locally only: `.env`

**Interfaces:**
- Consumes: deployed HTTPS API URL and the three Kapso values.
- Produces: a live phone-number webhook connected to the API.

- [ ] **Step 1: Configure the selected phone number**

In the Kapso project, confirm the selected number is connected and inbound processing is enabled. Copy its Meta `phone_number_id` and create a project API key under **Integrations → API keys**.

- [ ] **Step 2: Create the webhook**

Register `{PUBLIC_API_URL}/webhooks/kapso` as a Kapso-format v2 webhook with a fresh secret, `active: true`, `events: ["whatsapp.message.received"]`, and buffering disabled. Put the same secret and number ID in `.env`.

- [ ] **Step 3: Verify text end to end**

Send a text to the WhatsApp number. Confirm the API logs one normalized message, the backend handler receives it, and the returned response arrives in WhatsApp.

- [ ] **Step 4: Verify image end to end**

Send one JPEG/PNG image with a caption. Confirm the handler receives non-empty bytes with an image MIME type and the reply arrives.

- [ ] **Step 5: Verify PDF end to end**

Send one PDF. Confirm the handler receives non-empty bytes, `application/pdf`, and its filename when supplied, then the reply arrives.

- [ ] **Step 6: Verify the Mistral handoff**

With the backend's real handler connected, confirm Mistral can describe the test image and extract a known sentence from the test PDF. This validates the byte contract without adding Mistral code to this branch.

- [ ] **Step 7: Final repository check**

Run: `pnpm build && pnpm typecheck && git status --short`

Expected: build and typecheck exit `0`; `.env` remains untracked and no generated secrets appear in tracked files.
