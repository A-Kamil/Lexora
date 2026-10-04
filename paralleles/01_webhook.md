# Brief 01 — Webhook WhatsApp (apps/api)

## Contexte
Lexora : un proche appelle ou écrit au numéro WhatsApp du cabinet la nuit (ex. garde à vue) ; l'IA qualifie, l'avocat reçoit une alerte. Pile : API Fastify (`apps/api`) qui accepte et enregistre, worker (`apps/worker`, autre session) qui analyse et alerte, stockage derrière le contrat `CaseStore`/`JobQueue` (`packages/shared/src/ports.ts`), implémenté en mémoire (`MemoryStore`, `MemoryQueue`) en attendant Postgres. Déjà fait : squelette API (`/health`), `@lexora/ai`, le contrat.

## Worktree, réseau, secrets
Worktree `../Lexora-webhook`, branche `feat/webhook`. Réseau : registre npm. Secrets : aucun (les tests utilisent un faux `TWILIO_AUTH_TOKEN`).

## Périmètre
`apps/api/` uniquement (+ `pnpm-lock.yaml`).

## Conception tranchée
- `src/app.ts` : `buildApp({ store: CaseStore, queue: JobQueue, config })` renvoie l'instance Fastify (testable par `app.inject()`). `src/index.ts` compose : config, `MemoryStore.seeded()` + `MemoryQueue` tant que `STORE_MODE` ≠ `db` (seul mode disponible aujourd'hui : `memory`), écoute, arrêt propre.
- Route `POST /webhooks/twilio` (corps `application/x-www-form-urlencoded`, `@fastify/formbody`, limite 256 Kio) :
  1. **Signature d'abord** : `twilio.validateRequest(authToken, header X-Twilio-Signature, PUBLIC_BASE_URL + '/webhooks/twilio', tous les champs du formulaire)`. Invalide → 403. Pas d'interrupteur de contournement, sauf `APP_MODE=test` réservé aux tests.
  2. Champs requis : `From`, `MessageSid`, `AccountSid` (= `TWILIO_ACCOUNT_SID` si configuré), `NumMedia`. Malformé → 400.
  3. `From` `whatsapp:+33…` → E.164 `+33…`. Hors `DEMO_ALLOWED_NUMBERS` (liste séparée par des virgules ; vide = tout refuser) → 200 `<Response/>` sans rien stocker, raison journalisée **sans le contenu**.
  4. `store.resolveParticipant` : `absent` ou `ambiguous` → 200 `<Response/>`, rien stocké, raison journalisée. Si la personne est l'avocat (`role: 'lawyer'`) → 200, rien stocké (une salutation de l'avocat ne déclenche pas d'analyse).
  5. Client trouvé : `store.saveInboundMessage({..., media: [{index, url: MediaUrl{i}, contentType: MediaContentType{i}}]})`. Si `created` → `queue.enqueue('process-inbound', { messageId })`. Doublon → rien de plus.
  6. Réponse `200`, `content-type: application/xml`, corps `<Response/>`. Erreur de stockage → 503. **Aucun appel IA ni téléchargement avant la réponse.**
- Config (Zod, dans `apps/api/src/config.ts`, ne modifie pas `packages/shared/src/config.ts`) : `PORT`, `APP_MODE` (`demo`|`test`), `PUBLIC_BASE_URL`, `TWILIO_AUTH_TOKEN`, `TWILIO_ACCOUNT_SID?`, `DEMO_ALLOWED_NUMBERS`, `STORE_MODE` (`memory` par défaut). `DATABASE_URL` n'est plus requis en mode `memory`.
- Mode mémoire de démo : comme API et worker sont deux processus et que la file mémoire ne traverse pas les processus, `index.ts` en `STORE_MODE=memory` passe à `MemoryQueue` un rappel qui importe dynamiquement `@lexora/worker` et appelle `processInbound(deps, messageId)` s'il existe (sinon il journalise « worker absent »). Ce raccourci est documenté comme provisoire ; en mode `db`, ce sera pg-boss.
- Journaux structurés (pino de Fastify) sans numéro complet ni texte de message : numéro masqué `+336******01`.

## Ordre de travail (une étape = un commit)
1. `config.ts` + `app.ts` + `/health/live` ; test `health-live`.
2. Route webhook avec signature ; tests : signature invalide → 403, valide → 200 XML.
3. Liste blanche, résolution, avocat ignoré ; tests : hors liste, absent, ambigu, avocat → rien stocké.
4. Stockage + file + doublons ; tests : un message → 1 message + 1 tâche ; même `MessageSid` deux fois → toujours 1 et 1 ; média → `media[]` rempli.
5. `index.ts` + mode mémoire avec appel dynamique du worker ; `README` court dans `apps/api/` (variables, commande ngrok, URL à coller dans le bac à sable Twilio).

## Critère de réussite
`pnpm -r build && pnpm --filter @lexora/api test` : tous les tests verts, dont les 9 cas des étapes 1 à 4.

## En cas de blocage
`twilio` introuvable ou incompatible → implémente la vérification HMAC-SHA1 toi-même (URL + paramètres triés concaténés, base64), avec le même test. `@fastify/formbody` absent → parse le corps toi-même avec `URLSearchParams`.
