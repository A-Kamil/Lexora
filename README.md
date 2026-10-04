# Lexora

**WhatsApp legal intake.** A client sends voice notes and documents to one WhatsApp number. Lexora transcribes the voice (Voxtral), reads the documents (Mistral OCR), classifies and summarises them, asks the qualifying questions, and delivers a structured case file to the lawyer's dashboard. The client gets a summary at the end. Lexora informs and qualifies; only the lawyer advises.

## Run

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
cp .env.example ~/.config/hacklaw/lexora.env && chmod 600 ~/.config/hacklaw/lexora.env   # fill it in
./run.sh                       # http://localhost:8000/avocat  ·  /simu (offline simulator)
ngrok http 8000                # then paste https://<ngrok>/whatsapp in the Twilio sandbox "When a message comes in"
```

## Flow

`POST /whatsapp` (Twilio) → voice → Voxtral · documents → OCR → classification + summary → intake chat (mistral-medium) → on « fin » or when complete: case file (facts, timeline, notification date, urgency, documents, questions for the lawyer, missing documents) → lawyer dashboard `/avocat` → summary sent back to the client.

Only allowlisted numbers are processed (`LEXORA_ALLOWED_NUMBERS`); everything else is dropped before storage. Client content is wrapped as data, never instructions.
