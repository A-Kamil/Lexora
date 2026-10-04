# Lexora — demo runbook (demo PC)

Flow: a WhatsApp message (text, voice note, photo, PDF) reaches the Kapso number → `POST /webhooks/kapso`
(HMAC checked) → case store → intake agent replies to the sender (Mistral) ∥ legal lookups (Légifrance,
Judilibre, ECHR) → urgency analysis → WhatsApp alert to the lawyer if HIGH/CRITICAL → lawyer dashboard.

**Use the phone's hotspot, not the venue wifi** (DNS failures, 14 KB/s downloads).

## 1. Once: install

```bash
git clone https://github.com/A-Kamil/Lexora.git && cd Lexora      # or: git checkout main && git pull --ff-only
npx -y pnpm@11.19.0 install && npx -y pnpm@11.19.0 -r build
mkdir -p ~/.local/bin && curl -L --fail -o ~/.local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared
```

## 2. `.env` at the repo root (git-ignored — never paste values in a chat or on screen)

| Variable | Value |
|---|---|
| `DATABASE_URL` | keep the `.env.example` value (required by the parser) |
| `MISTRAL_API_KEY` | Mistral key |
| `PISTE_CLIENT_ID`, `PISTE_CLIENT_SECRET` | Légifrance/Judilibre (share privately, never in chat) |
| `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `KAPSO_WEBHOOK_SECRET` | Kapso dashboard (sandbox number) |
| `DEMO_LAWYER_PHONE` | lawyer phone, E.164 `+33…` (12 characters) |
| `DEMO_ALLOWED_NUMBERS` | the same lawyer number |
| `DEMO_OPEN_INTAKE` | `true` |
| `DATA_MODE` | **`memory`** for the demo: dashboard API + `/demo` + JSON file persistence. Without it the API uses Postgres (`docker compose up -d` first) and the dashboard has no read API yet |
| `AI_MODE` / `MESSAGING_MODE` / `LEGAL_CONTEXT_MODE` | `live` / `live` / `direct` |

Check without printing values:
```bash
awk -F= '/^[A-Z_]+=/{print $1" length "length($2)}' .env      # no 0 except optional ones
grep -oE '^[A-Z_]+=' .env | sort | uniq -d                     # must print nothing
```

## 3. Kapso sandbox (+56 9 2040 3095)

- Every phone used in the demo (client and lawyer) must be **activated**: Kapso dashboard → sandbox session for that
  number → send the 6-character code to the sandbox number (code valid 15 min).
- The lawyer phone writes "bonjour" to the sandbox once (opens WhatsApp's 24 h window; it is never analysed).

## 4. Start (3 terminals, in this order)

```bash
cd apps/api && npx -y pnpm@11.19.0 dev                          # A — wait for "lexora api ready" (ai/messaging live)
~/.local/bin/cloudflared tunnel --url http://localhost:3000      # B — copy the https://….trycloudflare.com URL
cd apps/web && npx -y pnpm@11.19.0 dev                          # C — lawyer dashboard: http://localhost:5173
```

Kapso → Sandbox WhatsApp → Manage Webhooks: `https://<tunnel>/webhooks/kapso`, event `whatsapp.message.received`,
buffering off, secret = `KAPSO_WEBHOOK_SECRET`. Check `https://<tunnel>/health` → `{"status":"ok"}`.
**The tunnel URL changes every time cloudflared restarts: update Kapso each time.**

Cases are saved in `apps/api/data/lexora-store.json` and survive an API restart. Clean slate before the pitch:
stop the API, `rm -f apps/api/data/lexora-store.json`, start it again.

## 5. Demo script

1. Client phone: "Bonsoir, mon fils a été arrêté ce soir, il est en garde à vue." → agent introduces itself and asks
   one question (seconds); ~25 s later the lawyer phone gets `LEXORA — CRITICAL` with the callback number, the client
   gets "a lawyer has been alerted".
2. Voice note with details → transcribed (Voxtral), next question.
3. Photo/PDF of the **fictional** police report → OCR + description, acknowledged by type.
4. "Doit-il parler aux policiers ?" → the agent does not advise: the lawyer will answer.
5. Dashboard (`:5173`): case at CRITICAL, analysis, missing information, documents, conversation,
   **legal sources consulted** (queries sent, results, references).

Fictional names only: message text is sent to Légifrance/Judilibre as the search query.

## If something fails

| Symptom | Cause |
|---|---|
| nothing in terminal A | tunnel down or old URL in Kapso |
| `401` | `KAPSO_WEBHOOK_SECRET` differs from Kapso |
| `400 Unexpected phone number` | wrong `KAPSO_PHONE_NUMBER_ID` |
| `EADDRINUSE :3000` | an old API still runs: `ss -ltnp \| grep :3000`, then `kill <pid>` |
| `ConnectionError` (Mistral) | network: switch to the hotspot |
| no reply / `Kapso message send failed` | phone not activated in the sandbox |
| dashboard "backend unreachable" | terminal A not running |
| analysis slower than ~40 s | add `MISTRAL_ANALYSIS_MODEL=mistral-medium-latest` to `.env` |

Fallback without WhatsApp: `MESSAGING_MODE=fake`, then
`npx -y pnpm@11.19.0 --filter @lexora/worker demo "Bonsoir, mon fils a été arrêté ce soir…"`.
