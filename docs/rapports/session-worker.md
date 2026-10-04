# RAPPORT — Brief 02, Worker (`apps/worker`, branche `feat/worker`)

## Fait
| Étape | Commit | Contenu |
|---|---|---|
| 1 | `64e983c` | `config.ts` (Zod : `AI_MODE`, `MESSAGING_MODE`, `LEGAL_CONTEXT_MODE`, `DEMO_ALLOWED_NUMBERS`, par défaut fake/mock), ports `AiPort` / `Messenger` / `LegalPort` / `MediaDownloader`, fakes déterministes, implémentations live (`@lexora/ai`, SDK Twilio 6.1.2, téléchargement média) |
| 2 | `dea41b4` | `processInbound(deps, messageId)` : analyse → `saveAnalysis` idempotent → alerte avocat déterministe (≤ 1 200 caractères) → accusé client |
| 3 | `49dffc5` | Médias : vocal → Voxtral → `setMessageTranscript` ; PDF/JPEG/PNG → OCR → document `ready` ; échec → document `failed`, l'analyse a quand même lieu |
| 4 | `44f1190` | Sources juridiques : `LEGAL_CONTEXT_MODE` mock/disabled/direct, sources dans `legalSources` et dans le résultat enregistré |
| 5 | `2a5dfd8` | `src/main.ts` + `pnpm --filter @lexora/worker demo "texte"` (MemoryStore, sans WhatsApp) |
| 6 | dernier commit | Vérification réelle consignée ci-dessous |

Tests : **20 verts** (`node:test`, aucun appel réseau), dont les 7 cas des étapes 2 et 3.

## Non fait
- Consommateur de file réel (pg-boss) : attend `packages/db`. `pnpm --filter @lexora/worker start` le signale et sort avec le code 1.
- Envoi Twilio réel : non testé (le brief ne le demande pas ; `MESSAGING_MODE=fake` pendant la vérification).

## Décisions prises seul
1. **Liste `DEMO_ALLOWED_NUMBERS` appliquée seulement en `MESSAGING_MODE=live`.** En fake rien ne part, donc la liste ne protège rien ; l'appliquer aurait empêché l'alerte `simulated` attendue par le brief sans configuration. En live, une liste vide refuse **tout** envoi (fermée par défaut).
2. **L'accusé client ne dit « Un avocat du cabinet a été prévenu » que si l'alerte est réellement partie (`sent`/`simulated`).** Sinon (cas LOW/MEDIUM, numéro refusé, pas d'avocat, échec d'envoi) : « Votre message a bien été reçu. Ceci n'est pas un conseil juridique. » Pour ne jamais affirmer à une famille quelque chose de faux. L'accusé n'est envoyé que si l'expéditeur est le client du dossier.
3. **Échec de l'IA (exception) → analyse de repli `HIGH`, `status: 'fallback'`, l'avocat est alerté.** Même logique que le repli de `analyzeCase` : un cas urgent ne doit pas disparaître.
4. **Idempotence des médias** : pas de nouvelle transcription si le message est déjà `voice`, pas de nouvelle extraction si un document existe déjà pour ce message. Évite les doublons quand la tâche est rejouée.
5. **Vocal illisible et texte vide** : l'analyse reçoit le texte de remplacement « [message sans texte exploitable : média non lu] » plutôt qu'une chaîne vide.
6. **Types de média** : seulement ceux du brief (`audio/*`, PDF, JPEG, PNG). DOCX (pris en charge par `@lexora/ai`) est ignoré avec un journal `media_unsupported`.
7. **Téléchargement** : HTTPS sur `api.twilio.com` uniquement, Basic auth, redirection suivie (le CDN de Twilio ; `fetch` retire l'en-tête `Authorization` hors domaine), 10 Mio vérifiés sur `content-length` puis pendant la lecture du flux.
8. **Script de test** : `node --test "dist/__tests__/*.test.js"` au lieu de `node --test dist/__tests__/`. Node 24.13 traite le dossier comme un fichier et échoue.
9. **Démo** : le client fictif du `MemoryStore.seeded()` est renommé « Martin Exemple (fictional) » dans `main.ts`, pour que la recherche juridique en `direct` masque bien ce nom (`redactForExternal`).
10. Les modes `disabled`/`mock`/`direct` passent tous par `gatherLegalContext` de `@lexora/ai`, qui ne touche pas le réseau en mock et en disabled.

## Demandes de contrat
- **`StoredMessage` n'expose pas les médias** (`InboundMessageInput.media` est perdu : `MemoryStore` ne le garde pas, `getMessage` ne le rend pas). Le worker ne peut donc pas savoir quels vocaux/PDF télécharger. Contournement local : `WorkerDeps.mediaOf?(message)`, qui lit par défaut un champ `media` sur le message enregistré s'il existe (c'est ce que font les tests). Proposition : `StoredMessage.media: InboundMedia[]`, ou `CaseStore.getMessageMedia(messageId)`.
- Ajouts optionnels à `WorkerDeps` hors du type du brief : `downloader`, `log`, `urgencyCriteria`, `mediaOf`.

## Blocages / remarques
- `.env` contient deux lignes `MISTRAL_API_KEY` (la 3 vide, la 7 remplie). Ça fonctionne (la dernière l'emporte) mais c'est fragile.
- Pendant la vérification de présence de la clé, **le premier caractère de `MISTRAL_API_KEY` a été affiché** dans ma console (un `sed` mal écrit). Aucune autre partie, rien dans un fichier ni dans un commit. Signalé par transparence.
- En `direct`, 2 recherches juridiques sur 4 ont échoué (journal `legal_context … "failed":2`, probablement les deux recherches Légifrance par code). Judilibre et CEDH ont répondu. Non creusé : `packages/ai` est hors périmètre.
- Moteur Node local 24.13.0 au lieu du 24.19.0 demandé (avertissement pnpm, sans effet).

## Vérification réelle (étape 6), 2026-10-04 vers 14:20, 1 analyse (1 à 2 appels Mistral)
```
AI_MODE=live LEGAL_CONTEXT_MODE=direct MESSAGING_MODE=fake pnpm --filter @lexora/worker demo "Bonsoir, je suis la mère de Martin Exemple, il a été arrêté ce soir et il est en garde à vue au commissariat."

modes: AI=live MESSAGING=fake LEGAL=direct
{"level":"info","event":"legal_context",...,"sources":6,"lookups":4,"failed":2}
{"level":"info","event":"analysis_saved",...,"urgency":"CRITICAL","status":"ok","legalSources":6}
{"level":"info","event":"outbound_simulated",...,"purpose":"lawyer_alert","to":"+336*****002"}
{"level":"info","event":"outbound_simulated",...,"purpose":"client_reply","to":"+336*****001"}

=== Analyse ===  model mistral-medium-latest, status ok, urgency CRITICAL
urgencyReason : La garde à vue est en cours (mentionnée comme actuelle dans le dernier message du 2026-10-04).
legalSources : Cass. cr 2016-10-04 n° 16-81.778 ; Cass. cr 2017-06-21 n° 16-84.158 ; Cass. cr 2015-11-17 n° 15-83.437 ; CEDH art. 7 ; CEDH art. 5 ; CEDH art. 13
recommendedActions citent les articles 63-3-1 et 63-4-1 du code de procédure pénale (présents dans les sources récupérées)

=== Envois ===
--- lawyer_alert → p-lawyer [simulated]
LEXORA — CRITICAL
Martin Exemple (fictional) — Affaire pénale (fictional)
Martin Exemple est actuellement en garde à vue au commissariat, nécessitant une assistance juridique immédiate.
Pourquoi : La garde à vue est en cours (mentionnée comme actuelle dans le dernier message du 2026-10-04).
À faire : rappeler le client maintenant.
--- client_reply → p-client [simulated]
Votre message a bien été reçu. Un avocat du cabinet a été prévenu. Ceci n'est pas un conseil juridique.
```
Appels Mistral consommés pendant la session : 1 analyse (≤ 2 appels), sur 10 autorisés.

## Vérification en 2 minutes
```bash
cd ../Lexora-worker
pnpm install && pnpm -r build && pnpm --filter @lexora/worker test          # 20 tests verts, hors ligne
pnpm --filter @lexora/worker demo "Mon fils est en garde à vue"              # fake : CRITICAL + alerte simulated
pnpm --filter @lexora/worker demo "Quels sont vos horaires ?"                # fake : LOW, pas d'alerte
# réel (1 à 2 appels Mistral, aucun envoi) :
AI_MODE=live LEGAL_CONTEXT_MODE=direct MESSAGING_MODE=fake pnpm --filter @lexora/worker demo "Bonsoir, je suis la mère de Martin Exemple, il a été arrêté ce soir et il est en garde à vue au commissariat."
```
