# Lexora

**WhatsApp legal intake.** A client writes to one WhatsApp number — text, voice notes,
photos, PDFs. Lexora opens a case, asks the qualifying questions, transcribes and reads
every document, looks up the relevant law, rates the urgency, alerts the lawyer on WhatsApp
when it is high or critical, and lays the whole case out on the lawyer's dashboard.
Lexora informs and qualifies; only the lawyer advises.

Built at the LLM x Law Hackathon Paris (Stanford Law × Mistral AI), 4 October 2026.

https://github.com/user-attachments/assets/b049fdda-12a1-432a-82bf-9df9b141858f

## Flow

```text
WhatsApp (Kapso) ──► POST /webhooks/kapso  (HMAC checked)
                       ├─► case store
                       ├─► intake agent (Mistral) ──► reply to the client
                       ├─► voice → Voxtral · documents → OCR · photos → vision model
                       ├─► legal lookups: Légifrance, Judilibre (PISTE), ECHR
                       └─► urgency analysis ──► WhatsApp alert to the lawyer (HIGH / CRITICAL)
lawyer dashboard (apps/web) ◄── GET /api/cases
```

To run the demo end to end (Kapso sandbox, tunnel, `.env`, script, troubleshooting),
follow [`DEMO.md`](DEMO.md).

## Layout

```text
apps/api/          Fastify: Kapso webhook, read API, /demo; runs the worker in-process
apps/worker/       intake pipeline per inbound message: media, document retrieval,
                   conversation, analysis, legal context, lawyer alert
apps/web/          lawyer dashboard — Vite, React 19, Tailwind 4 (French)
packages/ai/       Mistral calls: conversation, analysis, OCR, vision, transcription, legal sources
packages/shared/   domain contracts and Zod schemas; imports no database or provider SDK
packages/db/       every domain SQL query, the Drizzle schema and migrations
tests/integration/ runs against a real PostgreSQL it provisions and drops itself
emmanuel/          first prototype in Python (Twilio, control point with an HMAC-chained
                   journal); standalone, see its README
```

Dependency direction is `shared ← db`; applications consume both without writing SQL of
their own. `DATA_MODE=memory` (the demo setting) keeps cases in
`apps/api/data/lexora-store.json`; without it the API uses PostgreSQL, where the dashboard
has no read API yet.

The data layer follows [the plan](docs/superpowers/plans/2026-10-04-repository-backend.md)
and [the design](docs/superpowers/specs/2026-10-04-backend-design.md).

The sections below cover the PostgreSQL data layer.

## Run it

Requires Node 24.11.0 (see `.node-version`), pnpm 10.32.1, and Docker for the database.

```bash
pnpm install --frozen-lockfile
cp .env.example .env            # local defaults already match compose.yaml
docker compose up -d db         # PostgreSQL 16.13 on 127.0.0.1:5435
pnpm db:migrate                 # applies reviewed SQL from packages/db/drizzle/
```

`db` is the only service in `compose.yaml`; it binds **5435** to avoid colliding with other
local PostgreSQL instances, and keeps its data in the named volume `lexora_pgdata`.

## Checks

```bash
pnpm check             # eslint, prettier, and tsc over packages, tests and tool configs
pnpm test              # unit tests; no database, no credentials
pnpm test:integration   # builds, then runs the suite against PostgreSQL
pnpm build             # compiles packages in dependency order
```

`pnpm test:integration` needs a reachable PostgreSQL and an identity allowed to
`CREATE DATABASE`; it creates a throwaway database per run and drops it afterwards, so it
never touches your development data. Add a filename to narrow it:
`pnpm test:integration -- data.test.ts`.

`pnpm db:generate` regenerates a migration after a schema change. Review the emitted SQL as
code and commit it; `drizzle-kit push` is deliberately not wired up.

## Environment

Every variable is documented in `.env.example`. The data layer reads three:
`DATABASE_URL` (the application identity), `MIGRATION_DATABASE_URL` (a separate
schema-migration identity, higher-privilege in a deployed environment),
and `TEST_ADMIN_DATABASE_URL` (integration tests only).

Provider credentials (Mistral, Kapso, PISTE) are read only by `apps/api`. With
`AI_MODE=fake`, `MESSAGING_MODE=fake` and `LEGAL_CONTEXT_MODE=mock` (the `.env.example`
defaults) nothing reaches an external service.

## Resetting the local database

```bash
docker compose down -v && docker compose up -d db && pnpm db:migrate
```

`down -v` destroys the volume, so this discards everything in the local database.

This is a synthetic single-firm demo. Before any real client data, the design requires
end-user authentication and authorization, participant consent and onboarding, retention
and deletion decisions, provider data-handling agreements, and a tested restore procedure.
None of that is done here.
