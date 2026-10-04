# Lexora Hackathon Backend Design

## Goal

Deliver one complete WhatsApp conversation loop:

```text
WhatsApp message
→ Kapso webhook
→ identify client, conversation, and case
→ save inbound message
→ load case context and recent messages
→ ask Mistral for a response
→ save assistant response
→ send response through Kapso
→ WhatsApp client receives it
```

## Scope

This is a single-firm hackathon demo. It handles text messages for one seeded client and case. The backend informs and collects facts; it does not provide definitive legal advice.

The backend is one Fastify process. It uses Postgres through Drizzle, Mistral for response generation, and Kapso for WhatsApp webhooks and outbound messages. Kapso must receive `200 OK` within 10 seconds, so the route acknowledges a valid, saved message before continuing the Mistral and outbound work in the same long-running process.

## Minimal data model

- `people`: `id`, `name`, nullable unique `phone_number`, nullable unique `whatsapp_user_id`.
- `cases`: `id`, `client_id`, `title`, `status`, `context`.
- `conversations`: `id`, `case_id`, `person_id`, nullable unique `kapso_conversation_id`, `status`.
- `messages`: `id`, `conversation_id`, `direction`, `text`, nullable unique `provider_message_id`, `created_at`.

The seeded demo data supplies one client, one open case, and one conversation. Lookup accepts either the phone number or WhatsApp business-scoped user ID because Kapso webhook payloads may not always contain a phone number.

## Webhook behavior

- Route: `POST /webhooks/kapso`.
- Verify `X-Webhook-Signature` against the raw request body using HMAC-SHA256 and `KAPSO_WEBHOOK_SECRET`.
- Process only `X-Webhook-Event: whatsapp.message.received`.
- Accept both a direct payload and Kapso's buffered `data[]` envelope.
- Ignore non-text events for the first demo.
- Use the provider message ID as the duplicate guard.
- Save the inbound message before acknowledging the webhook.
- After acknowledgment, load the case context and recent messages, call Mistral, save the assistant message, then call Kapso `messages.sendText()`.

## Configuration

```text
DATABASE_URL=
KAPSO_API_KEY=
KAPSO_PHONE_NUMBER_ID=
KAPSO_WEBHOOK_SECRET=
MISTRAL_API_KEY=
MISTRAL_MODEL=
DEMO_CLIENT_PHONE=
```

## Deliberate shortcuts

No job queue, separate worker, automated tests, Docker, CI, OCR, documents, voice API, MCP, vector search, dashboard, delivery reconciliation, or lawyer escalation in the first implementation. Add durable jobs only if webhook work is lost during the demo or the backend moves to a runtime that stops work after sending the HTTP response.
