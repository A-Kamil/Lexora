"""Twilio WhatsApp: media download, outbound messages (allowlisted numbers only)."""
import os

import httpx
from twilio.request_validator import RequestValidator
from twilio.rest import Client

SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
FROM = os.environ.get("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886")  # Twilio sandbox number
ALLOWED = {n.strip() for n in os.environ.get("LEXORA_ALLOWED_NUMBERS", "").split(",") if n.strip()}


def allowed(number: str) -> bool:
    return not ALLOWED or number in ALLOWED


def valid_signature(url: str, params: dict, signature: str) -> bool:
    if os.environ.get("LEXORA_SKIP_SIGNATURE") == "1":
        return True
    return RequestValidator(TOKEN).validate(url, params, signature or "")


def download(url: str) -> bytes:
    r = httpx.get(url, auth=(SID, TOKEN), follow_redirects=True, timeout=60)
    r.raise_for_status()
    return r.content


def send(to: str, body: str):
    if not allowed(to):
        raise PermissionError(f"numéro hors liste blanche : {to}")
    # WhatsApp caps a message at 1600 characters on Twilio: split long texts.
    c = Client(SID, TOKEN)
    for i in range(0, len(body), 1500):
        c.messages.create(from_=FROM, to=to, body=body[i : i + 1500])
