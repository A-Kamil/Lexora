# twin/ — WhatsApp connector and gateway (from twin-ecosystem)

Code only, imported for the hackathon. No data, no session, no persona.

- `whatsapp/`: Go MCP connector (whatsmeow, QR login), SQLite + FTS5 store, voice-note download, transcription (`transcribe/`). Own Go module (`whatsapp/go.mod`).
- `gateway/app/`: MCP hub, agent loop, `prompt.wrap_tool_result` (client content framed as data, never instructions). `gateway/prompts/` is NOT included: provide your own persona files.

Lexora's main path uses Twilio (`app/`). Use this connector only with a dedicated demo number, never a personal account.
