# Demo runbook — WhatsApp → analysis → lawyer alert (memory mode)

One process: the API receives the WhatsApp message and runs the worker in-process (provisional until Postgres + pg-boss).

## 1. `.env` at the repo root (never committed)

```
MISTRAL_API_KEY=...            PISTE_CLIENT_ID=...   PISTE_CLIENT_SECRET=...   PISTE_ENV=prod
TWILIO_ACCOUNT_SID=...         TWILIO_AUTH_TOKEN=... TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
PUBLIC_BASE_URL=https://<ngrok-id>.ngrok-free.app
DEMO_CLIENT_PHONE=+33...       # the "mother" phone (joined the Twilio sandbox)
DEMO_LAWYER_PHONE=+33...       # the lawyer phone (joined the sandbox AND sent a message in the last 24 h)
DEMO_ALLOWED_NUMBERS=+33...,+33...
AI_MODE=live  MESSAGING_MODE=live  LEGAL_CONTEXT_MODE=direct  APP_MODE=demo  STORE_MODE=memory  PORT=3000
```

## 2. Run

```bash
pnpm install && pnpm -r build
ngrok http 3000                      # terminal 1, keep it running; copy the https URL into PUBLIC_BASE_URL
cd apps/api && pnpm dev              # terminal 2 (reads ../../.env)
```

Twilio console → Messaging → Try it out → WhatsApp sandbox settings → **When a message comes in**: `https://<ngrok-id>.ngrok-free.app/webhooks/twilio`, POST.

## 3. Show

- Open `http://localhost:3000/demo` on the projector (refreshes every 3 s; names only, never phone numbers).
- From the client phone: *"Bonsoir, mon fils a été arrêté ce soir, il est en garde à vue au commissariat."* (or a voice note).
- Expected: `/demo` shows CRITICAL with the reason; the lawyer phone receives the alert; the client phone receives the acknowledgment.

## Offline rehearsal (no keys, no WhatsApp)

`AI_MODE=fake MESSAGING_MODE=fake LEGAL_CONTEXT_MODE=mock` — or the worker alone: `pnpm --filter @lexora/worker demo "texte du message"`.

## Checks

`pnpm -r build`, then `node --test "apps/api/dist/__tests__/*.js"` (29) and `node --test "apps/worker/dist/__tests__/*.test.js"` (20), `node packages/ai/dist/smoke.js`.
