# gateway — point d'entrée unique du jumeau

FastAPI + SDK MCP Python v2. Reçoit une question, la **classe** (T0/T1/T2),
la **route** vers le modèle edge (local, Ollama) ou externe (T0 seulement),
interroge la **mémoire** (`mcp/memory`), laisse le modèle appeler les
**outils** des connecteurs (`mcp/whatsapp`…), et journalise la décision —
jamais le contenu.

```
client ──POST /chat──► gateway ──┬─ classify (règles + modèle EDGE)      jamais l'externe
                                 ├─ T0 → externe, persona public, 0 outil, 0 mémoire
                                 └─ T1/T2 → edge
                                       ├─ memory.recall / style_samples
                                       ├─ outils LECTURE des connecteurs (write exclus)
                                       └─ boucle tool-calls (≤ TWIN_GW_MAX_TOOL_ROUNDS)
```

## Lancer

```bash
cd gateway
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env            # externe optionnel
.venv/bin/python -m app         # http://127.0.0.1:8080
```

Prérequis en marche : Ollama (`~/.local/bin/ollama serve`, modèle `qwen3:4b` —
`qwen3:8b` via `TWIN_EDGE_MODEL`), `mcp/memory/server.py` (8082),
`mcp/whatsapp/twin-whatsapp` (8081). En service : `deploy/install-user-services.sh`.

Latence mesurée (RTX 2070 Max-Q, WSL2) : T0 externe ≈ 5 s ; T1 edge ≈ 15-25 s
(recall 2-4 s, prompt 3,5k tokens ≈ 8 s, génération ≈ 10 tok/s). Voir CLAUDE.md
« Hôte » — c'est le matériel, pas le code, qui fixe ce plafond.

```bash
curl -s localhost:8080/healthz | jq          # connecteurs joignables, modèles
curl -s localhost:8080/tools | jq            # outils exposés + tier + lecture seule
twin "De quoi j'ai parlé avec X cette semaine ?"   # clients/cli/twin.py
```

## API

| Route | Rôle |
|---|---|
| `POST /chat` `{message, history?}` | un tour ; renvoie `answer, tier, route, model, tools_called, facts, ms` |
| `GET /healthz` | état des connecteurs (via `tools/list`) et des modèles |
| `GET /tools` | outils qualifiés `connecteur__outil`, tier, lecture seule |
| `GET /connectors` | statut brut des connecteurs |

L'historique est **côté client** (le CLI garde 12 messages). Pas de session
serveur en v1.

## Règles de routage (CLAUDE.md, appliquées ici)

- La classification tourne **en local** (règles lexicales, puis le modèle edge).
  Règles : marqueurs T2 (argent, santé, intime, identifiants) et T1 (messages,
  agenda, pronoms de 1re/2e personne) — elles ne peuvent que **monter** le tier.
- **Défaut edge.** Externe seulement si T0 **et** `TWIN_ROUTER_ALLOW_EXTERNAL`
  **et** un endpoint externe configuré. En mode externe : persona **public**
  (`prompts/persona_public.md`), aucune mémoire, aucun outil. Le persona
  complet (`prompts/persona.md`) est biographique : il est T1 et ne sort jamais.
- Les outils d'**écriture** (`send_message`…) ne sont pas exposés au modèle
  tant que le HITL n'existe pas ; un appel à un outil inconnu est refusé et
  renvoyé au modèle comme erreur.
- Chaque résultat d'outil est encadré `[DONNÉES …]…[FIN DONNÉES]` et tronqué
  (`TWIN_GW_TOOL_RESULT_MAX_CHARS`) : c'est du contenu non fiable.
- Logs JSON sur stderr : `tier, route, model, reason, tools, facts, ms`.

## Configuration

Voir `.env.example`. Tout est surchargeable par l'environnement ; rien n'est
codé en dur. Les endpoints des connecteurs viennent de leurs manifestes
(`endpoint_env` → `TWIN_WA_LISTEN`, `TWIN_MEMORY_LISTEN`…).

## Tests

```bash
.venv/bin/python -m pytest -q     # unitaires, sans réseau (LLM et hub simulés)
```
