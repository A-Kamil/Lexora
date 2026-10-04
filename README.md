# Lexora backend (TypeScript)

Legal-intake backend: a known client's messages and documents are resolved to a case,
triaged into a structured assessment, and escalated to the assigned lawyer.

**Current state — the data layer only.** The nine domain tables, the shared contracts and
the data service exist and are tested. Nothing talks to Twilio, Mistral, object storage or
a legal source yet, and there is no queue, worker or HTTP API. Those arrive with their own
tasks in [the plan](docs/superpowers/plans/2026-10-04-repository-backend.md), against
[the design](docs/superpowers/specs/2026-10-04-backend-design.md). Those two documents are
normative; this README only says how to run what exists.

The Python prototype in [`emmanuel/`](emmanuel/README.md) is a separate, working system.
It is not migrated, reused or modified by this workspace.

## Layout

```text
packages/shared/   domain contracts and Zod schemas; imports no database or provider SDK
packages/db/       every domain SQL query, the Drizzle schema and migrations
tests/integration/ runs against a real PostgreSQL it provisions and drops itself
```

Dependency direction is `shared ← db`. Applications (`apps/api`, `apps/worker`) do not
exist yet and will consume both without writing SQL of their own.

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

Every variable is documented in `.env.example`. This milestone reads four:
`DATABASE_URL` (the application identity), `MIGRATION_DATABASE_URL` (a separate
schema-migration identity, higher-privilege in a deployed environment),
and `TEST_ADMIN_DATABASE_URL` (integration tests only).

Provider credentials are absent on purpose: nothing here can reach an external service.

## Resetting the local database

```bash
docker compose down -v && docker compose up -d db && pnpm db:migrate
```

`down -v` destroys the volume, so this discards everything in the local database.

This is a synthetic single-firm demo. Before any real client data, the design requires
end-user authentication and authorization, participant consent and onboarding, retention
and deletion decisions, provider data-handling agreements, and a tested restore procedure.
None of that is done here.
