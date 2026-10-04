# Brief 02 — Worker : analyse et alerte à l'avocat (apps/worker)

## Contexte
Lexora : la mère de Mr. X écrit ou envoie un vocal au numéro WhatsApp du cabinet la nuit (garde à vue) ; l'IA qualifie le cas ; si c'est urgent, l'avocat reçoit en deux minutes : « Mr. X — garde à vue — CRITICAL — rappeler maintenant ». L'API (autre session) enregistre le message et met en file `process-inbound {messageId}`. Toi, tu traites cette tâche. Déjà fait : `@lexora/ai` (`analyzeCase`, `extractDocument`, `transcribeVoice`, `gatherLegalContext` — testés en réel), le contrat `packages/shared/src/ports.ts` et `MemoryStore`.

## Worktree, réseau, secrets
Worktree `../Lexora-worker`, branche `feat/worker`. Réseau : registre npm ; `api.mistral.ai`, `api.piste.gouv.fr`, `oauth.piste.gouv.fr` et `api.twilio.com` uniquement pour la vérification finale (étape 6). Secrets : `MISTRAL_API_KEY`, `PISTE_CLIENT_ID`, `PISTE_CLIENT_SECRET` (dans `../../.env` du dépôt principal, copie-le dans ton worktree sans l'afficher : `cp ~/Lexora/.env .env`).

## Périmètre
`apps/worker/` uniquement (+ `package.json` du worker, `pnpm-lock.yaml`). Dépendance : `@lexora/ai: workspace:*`, `@lexora/shared: workspace:*`, `twilio`.

## Conception tranchée
- Exporte depuis `src/index.ts` (et `package.json` `exports` → `dist/index.js`) : `processInbound(deps, messageId)` et `type WorkerDeps = { store: CaseStore; ai: AiPort; messenger: Messenger; legal: LegalPort; clock: () => Date; config }`. Le démarrage du processus va dans `src/main.ts` (script `start`).
- **Modes** (config Zod dans `apps/worker/src/config.ts`) : `AI_MODE` `fake`|`live`, `MESSAGING_MODE` `fake`|`live`, `LEGAL_CONTEXT_MODE` `disabled`|`mock`|`direct`. Par défaut tout en `fake`/`mock`. `fake` IA : déterministe — texte contenant « garde à vue », « police custody », « arrested », « arrêté » → `CRITICAL` ; « convocation », « hearing », « audience » → `HIGH` ; sinon `LOW`. Messenger `fake` : enregistre l'envoi, statut `simulated`, jamais « sent ».
- `processInbound` :
  1. `store.getMessage` ; absent → fin (journal).
  2. Médias : audio (`audio/*`) → téléchargement Twilio (auth Basic SID:jeton, HTTPS `api.twilio.com` uniquement, 10 Mio max) → `transcribeVoice` (Voxtral) → `store.setMessageTranscript`. PDF/JPEG/PNG → `extractDocument` (OCR Mistral) → `store.saveDocument({status:'ready', extractedText, documentType})`. Échec → document `failed`, on continue.
  3. Contexte : `store.getCaseContext` → `gatherLegalContext(dernier texte, {mode, codes:['procedure_penale','penal'], clientIdentifiers:[nom du client]})` → `analyzeCase` avec `urgencyCriteria` lu dans `apps/worker/urgency-criteria.md` (texte libre défini par les juristes, crée une première version : CRITICAL = garde à vue en cours ou audience < 24 h ; HIGH = arrestation, convocation ou audience dans les jours qui viennent ; MEDIUM = dossier en cours, information nouvelle ; LOW = question générale).
  4. `store.saveAnalysis({ triggerKey: \`message:${id}:v1\`, ... })` ; si `created:false` → ne rien renvoyer (pas de seconde alerte).
  5. **Alerte** si `HIGH` ou `CRITICAL` et avocat présent : texte déterministe ≤ 1 200 caractères, sans IA : `LEXORA — {CRITICAL|HIGH}\n{client.displayName} — {case.title}\n{issue}\nPourquoi : {urgencyReason}\nÀ faire : rappeler le client maintenant.` → `store.saveOutbound({purpose:'lawyer_alert'})` → `messenger.send(lawyer.phoneE164, texte)` → `store.markOutbound`. Numéro hors `DEMO_ALLOWED_NUMBERS` → pas d'envoi, statut `failed` « numéro non autorisé ». Pas d'avocat → journal « aucun avocat assigné ».
  6. Accusé au client (`client_reply`) : « Votre message a bien été reçu. Un avocat du cabinet a été prévenu. Ceci n'est pas un conseil juridique. » — même chemin d'envoi.
- Journaux sans contenu de message, numéros masqués.

## Ordre de travail (une étape = un commit)
1. Config, ports `AiPort`/`Messenger`/`LegalPort` (fines enveloppes autour de `@lexora/ai` et du SDK Twilio), implémentations `fake` ; test : IA fake déterministe.
2. `processInbound` texte seul avec `MemoryStore.seeded()` ; tests : garde à vue → 1 analyse CRITICAL + 1 alerte `simulated` à l'avocat + 1 accusé client ; message LOW → analyse, pas d'alerte ; même message traité deux fois → 1 seule analyse, 1 seule alerte.
3. Médias : vocal → transcription puis analyse ; PDF → document `ready` dans le contexte ; échec de téléchargement → document `failed` et analyse quand même. Téléchargements simulés dans les tests.
4. Sources juridiques : `LEGAL_CONTEXT_MODE=mock` dans les tests, `direct` en démo ; les sources passent dans `legalSources`.
5. `src/main.ts` : en attendant pg-boss, boucle locale `pnpm --filter @lexora/worker demo "texte du message"` qui crée un message dans `MemoryStore.seeded()` et appelle `processInbound` — c'est la démo sans WhatsApp.
6. **Vérification réelle** (≤ 10 appels Mistral) : `AI_MODE=live LEGAL_CONTEXT_MODE=direct MESSAGING_MODE=fake pnpm --filter @lexora/worker demo "Bonsoir, je suis la mère de Martin Exemple, il a été arrêté ce soir et il est en garde à vue au commissariat."` → CRITICAL, sources, alerte simulée affichée. Consigne la sortie (sans clé) dans RAPPORT.md.

## Critère de réussite
`pnpm -r build && pnpm --filter @lexora/worker test` verts (au moins les 7 cas des étapes 2 et 3) et la vérification réelle de l'étape 6 consignée.

## En cas de blocage
SDK Twilio problématique → `fetch` sur `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` (formulaire `From`, `To`, `Body`, auth Basic). Échec Mistral en direct → garde `fake`, consigne l'erreur, ne dépasse pas 10 appels.
