# @lexora/api — WhatsApp webhook

Accepts Twilio WhatsApp messages, checks them, stores them, and queues `process-inbound` for the worker.
It never calls the AI or downloads media before replying.

## Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PUBLIC_BASE_URL` | yes | — | Public URL Twilio calls (ngrok), no trailing slash. Used to check the signature. |
| `TWILIO_AUTH_TOKEN` | yes | — | Checks `X-Twilio-Signature`. No bypass exists. |
| `TWILIO_ACCOUNT_SID` | no | — | If set, the `AccountSid` field must match it (400 otherwise). |
| `DEMO_ALLOWED_NUMBERS` | no | empty | Comma-separated E.164 numbers. **Empty = every sender is ignored.** |
| `PORT` | no | `3000` | |
| `APP_MODE` | no | `demo` | `test` only turns off Fastify logs (tests). |
| `STORE_MODE` | no | `memory` | `db` is refused until packages/db lands. |

## Run (memory mode)

```sh
pnpm -r build
cd apps/api && pnpm dev          # reads ../../.env
ngrok http 3000                  # copy the https forwarding URL into PUBLIC_BASE_URL, restart the API
```

In the Twilio console → Messaging → Try it out → WhatsApp sandbox settings → **When a message comes in**:
`https://<your-ngrok-id>.ngrok-free.app/webhooks/twilio`, method `POST`.
`PUBLIC_BASE_URL` must be exactly the URL in front of `/webhooks/twilio`, otherwise every request gets 403.

The seeded memory store has a fictional client `+33600000001` and a fictional lawyer `+33600000002`.
For a real phone to be accepted, it must be in `DEMO_ALLOWED_NUMBERS` **and** known to the store.

**Provisional:** in memory mode the queue cannot reach the worker process, so the API loads
`processInbound(deps, messageId)` from `@lexora/worker` and runs it in-process after replying
(`deps = { store, queue, log }`). If the worker is missing, the job is logged as "worker absent".
With `STORE_MODE=db` this will be pg-boss.

## Behaviour of `POST /webhooks/twilio`

1. Invalid or missing signature → 403.
2. Missing `From`/`MessageSid`/`AccountSid`/`NumMedia`, invalid media, wrong `AccountSid` → 400. Body > 256 KiB → 413.
3. Sender not allowlisted, unknown, ambiguous, or the lawyer → 200 `<Response/>`, nothing stored.
4. Client → message stored (idempotent on `MessageSid`), `process-inbound` queued once → 200 `<Response/>`.
5. Store or queue error → 503 (Twilio retries).

Logs never contain message text or full numbers (`+336******01`).

## Tests

```sh
pnpm -r build && pnpm --filter @lexora/api test
```
