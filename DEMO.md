# Lexora — live demo runbook (Kapso)

Flow: the client's WhatsApp message (text, voice note, photo or PDF) reaches the Kapso number →
`POST /webhooks/kapso` (HMAC checked) → stored → worker (Voxtral / Mistral OCR, Légifrance + Judilibre + ECHR,
Mistral urgency analysis) → WhatsApp alert to the lawyer if HIGH/CRITICAL → acknowledgement to the client.
`GET /demo` shows the case on the projector (names only, never phone numbers).

## 1. `.env` (repo root, git-ignored — never paste values in chat)

| Variable | Value |
|---|---|
| `DATABASE_URL` | keep the `.env.example` value (required by the config parser, unused by the in-memory demo) |
| `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET` | from the Kapso dashboard |
| `MISTRAL_API_KEY`, `PISTE_CLIENT_ID`, `PISTE_CLIENT_SECRET` | live AI and legal sources |
| `DEMO_CLIENT_PHONE`, `DEMO_LAWYER_PHONE` | the two demo phones, E.164 (`+336…`) |
| `DEMO_ALLOWED_NUMBERS` | both numbers, comma-separated |
| `AI_MODE` / `MESSAGING_MODE` / `LEGAL_CONTEXT_MODE` | `live` / `live` / `direct` |

## 2. Run

```bash
npx -y pnpm@11.19.0 install && npx -y pnpm@11.19.0 -r build
ngrok http 3000                         # terminal 1
cd apps/api && npx -y pnpm@11.19.0 dev  # terminal 2 → "lexora api ready"
```

Kapso dashboard → webhook: URL `https://<ngrok>/webhooks/kapso`, event `whatsapp.message.received`,
buffering off, same secret as `KAPSO_WEBHOOK_SECRET`.

## 3. Before going on stage

1. The **lawyer phone writes once to the Kapso number** (opens WhatsApp's 24 h window; its own messages are
   never analysed).
2. Rehearsal with `AI_MODE=fake MESSAGING_MODE=live`: checks Kapso both ways without Mistral.
3. Then full live: the "mother" sends *"Bonsoir, mon fils a été arrêté ce soir, il est en garde à vue."*
   → `/demo` shows CRITICAL, the lawyer phone receives `LEXORA — CRITICAL…`, the mother receives the
   acknowledgement.

## If something fails

| Symptom | Cause |
|---|---|
| nothing in the API log | ngrok down or wrong URL in Kapso (check http://localhost:4040) |
| `401` | `KAPSO_WEBHOOK_SECRET` differs from the dashboard |
| `400 Unexpected phone number` | wrong `KAPSO_PHONE_NUMBER_ID` |
| `sender is not a participant` | sender is not `DEMO_CLIENT_PHONE` (format `+33…`) |
| analysis shown, no WhatsApp alert | lawyer's 24 h window closed, or number not in `DEMO_ALLOWED_NUMBERS` |

Fallback without WhatsApp: `MESSAGING_MODE=fake`, then
`npx -y pnpm@11.19.0 --filter @lexora/worker demo "Bonsoir, mon fils a été arrêté ce soir…"` and show `/demo`.
