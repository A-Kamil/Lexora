# Lexora

**WhatsApp legal intake.** A client sends voice notes and documents to one WhatsApp number. Lexora transcribes the voice (Voxtral), reads the documents (Mistral OCR), classifies and summarises them, asks the qualifying questions, and delivers a structured case file to the lawyer's dashboard. The client gets a summary at the end. Lexora informs and qualifies; only the lawyer advises.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
cp .env.example ~/.config/hacklaw/lexora.env && chmod 600 ~/.config/hacklaw/lexora.env   # fill it in
./run.sh                       # http://localhost:8000/avocat  ·  /simu (offline simulator)
ngrok http 8000                # then paste https://<ngrok>/whatsapp in the Twilio sandbox "When a message comes in"
```

## Agents

| Agent | Role | Tools (through the control point) |
|---|---|---|
| `accueil` | Talks to the client on WhatsApp, qualifies, never advises | `demander_recherche_juridique`, `identifier_entreprise`, `noter_client`, `etat_dossier` |
| `chercheur` | Sub-agent called during the conversation: official texts and case law for the lawyer | `rechercher_textes`, `consulter_article` (Légifrance), `rechercher_jurisprudence` (Judilibre), `rechercher_convention_edh`, `consulter_article_cedh` (local) |
| `analyste_pieces` | Every document: Mistral OCR (PDF, DOCX, photos) → category + summary + key dates | — |
| `transcription` | Every voice note: Voxtral | — |
| `qualification` | End of conversation: extracts facts (dates, rupture type, signals) into the case file, summary for the client | — |
| `classificateur` | **Deterministic** urgency: rules in `app/data/urgence.json` (editable by the lawyer) → call today / within 48 h / written answer, with every rule that fired | — |

**Control point** (`app/policy.py`, inherited from mcp_rogue): every tool call is checked by code, not by a model. Tool not allowed for this agent → refused. Client name, phone or email in a request leaving the intake agent → removed before it goes out. Every decision is appended to a per-case journal chained by HMAC; the lawyer page shows it and whether the chain verifies.

Sessions: one open case per phone; idle for `LEXORA_SESSION_HOURS` → new case; the client can type « nouveau dossier ». Large documents: the first message contains a private upload link (`/depot/<token>`).

## Flow

`POST /whatsapp` (Twilio) or `/depot/<token>` → voice → Voxtral · documents → OCR → classification + summary → intake chat (mistral-medium) → on « fin » or when complete: case file (facts, timeline, notification date, urgency, documents, questions for the lawyer, missing documents) → deterministic urgency → lawyer dashboard `/avocat` (+ downloadable recap `/avocat/<id>/recap.md`: urgency and why, documents, every source consulted, agent journal, conversation) → summary sent back to the client.

Only allowlisted numbers are processed (`LEXORA_ALLOWED_NUMBERS`); everything else is dropped before storage. Client content is wrapped as data, never instructions.

## Tests

`python3 tests/test_urgency.py` — urgency rules.  
`python3 tests/smoke_offline.py` — full flow with Mistral and the public APIs mocked (no network, no key).

## Sources

| Source | Access |
|---|---|
| Légifrance (codes in force) | PISTE API |
| Judilibre (Cour de cassation) | PISTE API |
| Annuaire des entreprises | public API |
| European Convention on Human Rights + Protocols (FR, official) | local: `sources/Convention_FRA.pdf` → `app/data/cedh.json` (116 articles), supplied by the team's lawyer |
