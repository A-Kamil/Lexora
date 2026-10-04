# mcp/whatsapp — connecteur WhatsApp (Go)

Un seul binaire, un seul processus : un client WhatsApp
([whatsmeow](https://github.com/tulir/whatsmeow), protocole multi-device)
qui maintient un **miroir local** des messages dans SQLite, et un **serveur
MCP** (SDK Go officiel, Streamable HTTP ou stdio) qui l'expose au gateway.

```
WhatsApp ──whatsmeow──► session.db (appairage, clés)
                    └─► messages.db (chats, messages, index FTS5)  ◄── outils MCP ◄── gateway
```

**Tier T1** : rien de ce que ce connecteur renvoie ne doit atteindre un modèle
externe (cf. `CLAUDE.md`, routage par confidentialité).

## Pourquoi pas l'API officielle

La Cloud API WhatsApp Business ne donne accès qu'aux conversations d'un
numéro *business* — jamais à l'historique d'un compte personnel. whatsmeow
parle le protocole des clients « appareil lié » (comme WhatsApp Web). C'est
**hors CGU** : risque de bannissement faible en lecture seule, réel si on
automatise l'envoi. D'où `send_message` désactivé par défaut, et un compte
secondaire recommandé pour tester l'écriture.

## Lancer

```bash
cd mcp/whatsapp
go build -o twin-whatsapp .
TWIN_WA_DATA_DIR=./data ./twin-whatsapp
```

Au premier lancement, un QR s'affiche sur stderr : WhatsApp › Appareils
connectés › Connecter un appareil. L'historique arrive ensuite par blocs
(`sync_status` pour suivre). L'appairage est persistant dans `data/session.db`.

Le serveur MCP est sur `http://127.0.0.1:8081/mcp` (`/healthz` à côté).

## En service (systemd utilisateur)

Un connecteur « présence » doit tourner en permanence. Le processus au
premier plan dans un terminal ne survit ni à la fermeture de l'onglet ni à la
veille du portable.

```bash
mkdir -p ~/.local/bin ~/.local/share/twin ~/.config/systemd/user
cp twin-whatsapp ~/.local/bin/
[ -d data ] && mv data ~/.local/share/twin/whatsapp      # session + messages.db existants
cp twin-whatsapp.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now twin-whatsapp
loginctl enable-linger "$USER"                          # démarre sans session ouverte
journalctl --user -u twin-whatsapp -f                   # logs (stderr → journal)
```

Après un `go build`, `cp twin-whatsapp ~/.local/bin/ && systemctl --user restart twin-whatsapp`.

**Limites d'un backend sur portable + WSL2** : Windows arrête la VM WSL
quelques secondes après la fermeture du dernier terminal, et la veille coupe
tout. Palliatifs : une tâche planifiée Windows à l'ouverture de session qui
lance `wsl.exe -d <distro> --exec sleep infinity`, et désactiver la veille sur
secteur. La vraie réponse est un hôte toujours allumé (VPS free tier, ou un
petit ARM) — c'est la phase 2 du `CLAUDE.md`. Rassurant en attendant :
WhatsApp met en file les messages destinés à un appareil lié hors-ligne et
les livre à la reconnexion (`rattrapage hors-ligne` dans les logs) ; une
coupure fait perdre de la fraîcheur, pas des données.

## Historique complet

Le téléphone n'envoie l'historique profond que si le connecteur l'a demandé
**à l'appairage**, plafonds compris (`FullSyncDaysLimit`…). Un appairage fait
avec une version antérieure ne l'a pas : pour l'obtenir, arrêter le service,
supprimer `session.db` (et **seulement** lui — `messages.db` est conservé,
l'insertion est idempotente), relancer, rescanner le QR.

## Configuration (environnement uniquement)

| Variable | Défaut | Rôle |
|---|---|---|
| `TWIN_WA_DATA_DIR` | `data` | session + messages.db (**T1, gitignoré**) |
| `TWIN_WA_TRANSPORT` | `http` | `http` (gateway) ou `stdio` (inspecteur, tests) |
| `TWIN_WA_LISTEN` | `127.0.0.1:8081` | adresse HTTP ; un bind non-loopback déclenche un avertissement |
| `TWIN_WA_ALLOW_SEND` | `false` | expose `send_message` |
| `TWIN_WA_FULL_SYNC` | `true` | demander l'historique complet **au moment de l'appairage** (supprimer `session.db` pour changer) |
| `TWIN_WA_LOG_LEVEL` | `info` | `debug` inclut les logs whatsmeow |

## Outils MCP

| Outil | Lecture | Rôle |
|---|---|---|
| `list_chats` | ✔ | conversations récentes, filtre par nom |
| `get_messages` | ✔ | derniers messages d'une conversation (nom ou JID), pagination par `before` |
| `search_messages` | ✔ | plein texte FTS5, accents ignorés, filtres chat / dates |
| `list_calls` | ✔ | journal des appels (sens, média, issue, durée), filtres correspondant / dates |
| `call_stats` | ✔ | analytics d'appels : volumes, minutes, répartition heure × jour, top correspondants |
| `voice_notes` | ✔ | notes vocales avec transcription, durée, filtres conversation / dates |
| `sync_status` | ✔ | connexion, appairage, compteurs |
| `send_message` | ✘ | texte simple ; **HITL côté gateway** ; absent si `TWIN_WA_ALLOW_SEND` ≠ 1 |

Un nom de chat ambigu renvoie une erreur listant les candidats — jamais un
choix silencieux.

## Ce que le miroir stocke

Texte des messages, légendes des médias, type de média (`image`, `vocal`,
`document`…), position, fiche contact. **Pas** les fichiers médias, pas les
réactions, pas les accusés. Les identifiants LID (adressage anonymisé récent)
sont ramenés au numéro de téléphone quand la correspondance est connue.

## Appels (table `calls`)

Deux sources : les événements live (`CallOffer` → `CallAccept` → `CallTerminate`,
un appel = un `CallID`, durée = fin − décroché) et l'historique
(`CallLogMessage` avec issue et durée, stubs `CALL_MISSED_*` plus anciens).
Colonnes : correspondant, sens, média (voix/vidéo), issue (connected / missed /
rejected / failed), horodatages début/décroché/fin, durée, groupe, source.
L'historique n'arrive **qu'à l'appairage** : un appairage antérieur à cette
version n'a pas alimenté la table — les appels live la remplissent à partir de
maintenant, un ré-appairage la complète.

## Notes vocales → transcription (`transcribe/`)

`TWIN_WA_DOWNLOAD_VOICE=1` (défaut) : chaque vocal est téléchargé
(`data/media/voice/<numéro>/<id>.ogg`, file cadencée hors du fil d'événements ;
un média expiré côté serveur est marqué `error:` et n'est pas retenté).
`transcribe/transcribe.py` (faster-whisper `small`, CPU int8, FR) transcrit
les vocaux téléchargés, écrit `transcripts` (clé = conversation + message →
expéditeur, heure) et remplace le texte du message par `[vocal] …` : la
transcription devient cherchable par `search_messages` et visible partout.

```bash
cd transcribe && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python transcribe.py --watch          # ou l'unité deploy/systemd/twin-transcribe.service
```

Mêmes limites que l'historique : les vocaux stockés avant cette version
n'ont pas de média téléchargé ; un ré-appairage les fait revenir.

## Journalisation

Tout part sur **stderr** (stdout est réservé au JSON-RPC en mode stdio).
Compteurs et décisions uniquement — jamais le texte d'un message.

## Vérification rapide

```bash
curl -s http://127.0.0.1:8081/healthz
curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  http://127.0.0.1:8081/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sync_status","arguments":{}}}'
```
