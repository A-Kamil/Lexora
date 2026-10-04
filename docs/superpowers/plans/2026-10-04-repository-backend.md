# Lexora Kapso Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the smallest backend that receives a WhatsApp text through Kapso, uses the client's stored case context to generate a Mistral response, saves both messages, and replies through Kapso.

**Architecture:** One Fastify API process handles the webhook and runs the conversation pipeline. PostgreSQL stores clients, cases, conversations, and messages. The route verifies and saves the inbound event, returns `200 OK` within Kapso's 10-second window, then completes the Mistral and Kapso calls in the same long-running process.

**Tech Stack:** Node.js 24, TypeScript, pnpm, Fastify 5, Zod, PostgreSQL, Drizzle ORM, Mistral SDK, `@kapso/whatsapp-cloud-api`.

**Spec:** [Hackathon backend design](../specs/2026-10-04-backend-design.md)

## Global Constraints

- Optimize for the text-message golden path.
- Keep the existing TypeScript workspace minimal.
- Use Kapso for inbound and outbound WhatsApp messaging.
- Store every inbound and assistant message in Postgres.
- Return `200 OK` to Kapso within 10 seconds.
- Validate the Kapso signature before reading trusted webhook fields.
- Do not add automated tests or new documentation during implementation.
- Do not add a queue, worker flow, OCR, MCP, vector search, voice integration, or lawyer escalation yet.

## Review Focus

- The signature must be calculated from the untouched request bytes, not re-serialized JSON.
- A webhook may identify a client with a business-scoped user ID and no phone number.
- A repeated provider message ID must not trigger a second Mistral call or WhatsApp response.
- Kapso must receive `200 OK` within 10 seconds after the inbound message is saved.
- Work started after acknowledgment can be lost if the process crashes; this is an accepted hackathon limitation and the trigger for adding a durable queue.

## Repository Map

```text
apps/api/src/
  index.ts              # Fastify startup and health route
  kapso.ts              # Kapso client and webhook signature verification
  mistral.ts            # Prompt construction and Mistral call
  conversation.ts       # Complete inbound-to-reply pipeline
  webhook.ts            # POST /webhooks/kapso
packages/db/src/
  client.ts             # Postgres/Drizzle connection
  schema.ts             # Four demo tables
  queries.ts            # Case lookup and message reads/writes
  seed.ts               # One fictional client and case
  index.ts              # Package exports
packages/db/drizzle/    # Generated migration
```

The existing `apps/worker` remains unused for this milestone. Remove it later only if it is still unnecessary after the demo.

## Task 1: Minimal database and seeded case

**Files:** Create `packages/db`; modify root workspace scripts and `.env.example`.

**Produces:**

- `findClient(identity): Promise<Person | null>`
- `getActiveConversation(personId): Promise<ConversationContext | null>`
- `getRecentMessages(conversationId, limit): Promise<Message[]>`
- `saveMessage(input): Promise<Message>`

- [ ] Add `@lexora/db` with Drizzle, `pg`, and Drizzle Kit.
- [ ] Define `people`, `cases`, `conversations`, and `messages` exactly as described in the spec. Make `provider_message_id` unique so repeated webhooks do not create repeated messages.
- [ ] Create the first migration and add `db:migrate` and `db:seed` root commands.
- [ ] Seed one fictional client, open case, conversation, and short case context. Use `DEMO_CLIENT_PHONE` when provided so the live demo phone resolves to the seeded client.
- [ ] Implement the four query functions above. `getActiveConversation` returns the case context together with the conversation.
- [ ] Run `pnpm typecheck`, `pnpm build`, `pnpm db:migrate`, and `pnpm db:seed`. Query the four tables once to confirm the seeded records exist.

## Task 2: Mistral and Kapso clients

**Files:** Create `apps/api/src/mistral.ts` and `apps/api/src/kapso.ts`; update environment parsing.

**Produces:**

- `generateReply({caseContext, messages, latestMessage}): Promise<string>`
- `sendWhatsAppText({to, recipient, body}): Promise<string>`
- `verifyKapsoWebhook(rawBody, signature): boolean`

- [ ] Add the official Mistral and Kapso TypeScript clients.
- [ ] Require `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET`, `MISTRAL_API_KEY`, and `MISTRAL_MODEL` when starting the live API.
- [ ] Initialize Kapso's `WhatsAppClient` with `baseUrl: "https://app.kapso.ai/api/meta/"` and `kapsoApiKey`.
- [ ] Implement `sendWhatsAppText` with `client.messages.sendText({phoneNumberId, to, recipient, body})`. Pass both `to` and `recipient` when the webhook supplies both.
- [ ] Implement HMAC-SHA256 verification over the untouched raw body and compare the result to `X-Webhook-Signature` with a timing-safe comparison.
- [ ] Implement a short Mistral prompt containing the case context, up to 20 recent messages, and the latest message. Tell Mistral to ask one concise question at a time and avoid definitive legal advice.
- [ ] Run `pnpm typecheck` and `pnpm build`. Make one explicit Mistral call and one explicit Kapso sandbox send using fictional content.

## Task 3: Kapso webhook and conversation pipeline

**Files:** Create `apps/api/src/webhook.ts` and `apps/api/src/conversation.ts`; register the route in `apps/api/src/index.ts`.

**Produces:** `POST /webhooks/kapso` and `handleInboundMessage(event): Promise<void>`.

- [ ] Configure Fastify to preserve the raw JSON body for this route before parsing it.
- [ ] Reject an invalid or missing `X-Webhook-Signature` with `401`.
- [ ] Ignore events other than `whatsapp.message.received` with `200`.
- [ ] Normalize direct payloads and buffered envelopes (`batch: true`, `data: [...]`) into individual inbound messages.
- [ ] Extract the provider message ID, text, Kapso conversation ID, phone number when present, and business-scoped user ID when present. Ignore non-text messages for this milestone.
- [ ] For each message, resolve the client by phone number or WhatsApp user ID, find the active conversation and case, and save the inbound message. Unknown clients receive no case details and no Mistral call.
- [ ] Return `200 OK` after the inbound record is saved. Start `handleInboundMessage` without awaiting it; catch and log its errors so they do not become unhandled rejections.
- [ ] In `handleInboundMessage`, load the case context and 20 recent messages, call `generateReply`, save the response with direction `outbound`, and call `sendWhatsAppText`.
- [ ] If the provider message ID already exists, acknowledge it without calling Mistral or Kapso again.
- [ ] Run `pnpm typecheck` and `pnpm build`. Send a signed sample payload and confirm one inbound row and one outbound row are stored.

## Task 4: Live golden-path check

- [ ] Start the API on an HTTPS tunnel and register `POST /webhooks/kapso` for `whatsapp.message.received` on the Kapso demo number.
- [ ] Copy the webhook secret into `KAPSO_WEBHOOK_SECRET` and confirm invalid signatures return `401`.
- [ ] Send a WhatsApp text from the seeded demo phone.
- [ ] Confirm the backend resolves the client, conversation, and case; stores the inbound text; loads the case context; obtains a Mistral reply; stores the outbound text; and sends it through Kapso.
- [ ] Confirm the reply appears in WhatsApp and a duplicate webhook does not produce a second reply.

## Definition of Done

The milestone is complete when this exact path works with live providers:

```text
WhatsApp → Kapso → backend → Postgres → Mistral
         → Postgres → Kapso → WhatsApp
```

After that, choose the next feature from observed demo needs. Likely candidates are lawyer escalation, document ingestion, or durable background jobs. Do not add them before the golden path works.
