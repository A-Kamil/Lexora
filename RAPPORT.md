# RAPPORT — session webhook (feat/webhook, apps/api)

## Fait
- Étape 1 — `config.ts` (Zod), `app.ts` (`buildApp`), `GET /health/live`, test `health-live`.

## Non fait
- (en cours)

## Décisions prises seul
- **Script de test** : `node --test dist/__tests__/` (dossier) échoue sous Node 24 (le dossier est pris pour un fichier). Script : `node --test "dist/__tests__/*.js"`. Les aides de test sont dans `src/__tests__/support/` pour ne pas être comptées comme tests.
- **`APP_MODE`** : défaut `demo`. `test` coupe seulement les journaux Fastify ; il **ne contourne pas** la signature (option fermée : les tests signent réellement leurs requêtes avec un faux jeton).
- **`STORE_MODE`** : défaut `memory` ; `db` est accepté par le schéma mais refusé au démarrage tant que packages/db n'existe pas.

## Blocages
- Aucun.

## Demandes de contrat
- Aucune pour l'instant.

## Vérification en 2 minutes
```sh
cd ../Lexora-webhook
pnpm -r build && pnpm --filter @lexora/api test
```
