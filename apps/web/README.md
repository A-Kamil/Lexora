# Lexora — espace avocat (`@lexora/web`)

Interface de l'avocat : dossiers triés par urgence, analyse, documents classés par type,
échéances et échanges. Vite + React 19 + React Router 7 + Tailwind 4, en français.
Adaptée du front de Haoma (design system, mode nuit, transitions), sans ses écrans médicaux.

## Données de démo

Le backend n'expose pas encore d'API de lecture : `src/lib/api.ts` sert des données fictives
(`src/mocks/demo.ts`). Les composants ne dépendent que des signatures de ce module ; il suffira
d'y remplacer les corps par des `fetch`. Il n'y a pas d'authentification : « Accéder à mes
dossiers » ouvre une session fictive (`src/lib/session.ts`).

Les écrans se rafraîchissent toutes les 10 s (`src/hooks/usePolling.ts`).

## Commandes

```bash
pnpm --filter @lexora/web dev     # serveur de développement
pnpm --filter @lexora/web build   # typecheck + build
pnpm --filter @lexora/web lint
```
