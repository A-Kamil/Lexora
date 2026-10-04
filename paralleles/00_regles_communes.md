# Règles communes — sessions parallèles Lexora (hackathon, rendu 18:00)

## Autonomie
- Personne ne répondra pendant ta session. Face à une décision non couverte par ton brief : choisis l'option la plus prudente (fermée par défaut, la moins irréversible), note-la avec sa justification dans RAPPORT.md, continue.
- Ne boucle jamais plus de 3 fois sur un même problème : note-le, passe à l'étape suivante.
- **Heure limite : 15:45.** À 15:45, commite ce qui est vert, mets RAPPORT.md à jour, arrête-toi.

## Dépôt
- Travaille uniquement dans ton worktree et ta branche. Ne touche jamais à `main`, ne fusionne pas, ne pousse pas, ne force rien.
- **Contrat figé, ne pas modifier** : `packages/shared/src/ports.ts` et `packages/shared/src/memory.ts`. Si le contrat te manque, écris-le dans RAPPORT.md (section « Demandes de contrat ») et contourne localement.
- **Ne pas modifier** : `packages/ai/` (sauf bug bloquant, alors une ligne dans RAPPORT.md), `packages/db/` (un autre développeur y travaille), `emmanuel/`, `docs/`.
- Ne modifie que les dossiers de ton brief. `package.json` de ton app et `pnpm-lock.yaml` : autorisés (conflits bénins attendus à la fusion).
- Commits petits et fréquents, `pnpm -r build` vert avant chaque commit. Jamais de secret, de `.env`, de `dist/`, de donnée personnelle réelle dans un commit. Données de démo fictives uniquement (`+3360000000x`, noms marqués « fictional »).

## Pile imposée
Node 24, TypeScript strict (config du dépôt : `noUncheckedIndexedAccess`), ESM/NodeNext, pnpm workspaces (`npx -y pnpm@11.19.0` si `pnpm` absent), Fastify 5, Zod 4.6.5. Imports relatifs en `.js`.
**Tests** : `node:test` + `node:assert/strict`, fichiers dans `src/__tests__/*.ts` (compilés par `tsc -b`), lancés par `node --test dist/__tests__/`. Ajoute un script `"test"` dans le `package.json` de ton app. Aucun test n'appelle le réseau.

## Sécurité de la machine
Pas de sudo, pas d'installation globale, rien en dehors de ton worktree. Réseau : registre npm et les domaines de ton brief uniquement.

## Secrets
Lus depuis l'environnement (`node --env-file=../../.env` ou variables exportées), jamais affichés, même partiellement, jamais écrits dans un fichier versionné. Pour vérifier une présence : `[ -n "$MISTRAL_API_KEY" ] && echo présente`.

## Coûts
Mistral : **30 appels réels maximum** pour toute la session, uniquement pour la vérification finale en direct ; tout le reste en mode `fake`. Twilio : aucun envoi réel sauf vers les numéros de `DEMO_ALLOWED_NUMBERS`, et seulement à l'étape prévue du brief.

## Rapport
`RAPPORT.md` à la racine du worktree, mis à jour après chaque commit : fait (avec commits), non fait et pourquoi, décisions prises seul avec justification, blocages, demandes de contrat, **vérification en 2 minutes** (commandes exactes).
