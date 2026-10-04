"""Channel-independent intake logic: used by the Twilio webhook and by the offline simulator."""
import json
import os
import time

from . import ai, store

MEDIA_DIR = os.environ.get("LEXORA_MEDIA", "data/media")
END_WORDS = {"fin", "terminé", "termine", "c'est tout", "stop"}


def handle(phone: str, text: str, media: list[tuple[bytes, str, str]], send) -> None:
    """media = [(bytes, content_type, filename)]; send(to, body) delivers a reply on the channel."""
    case_id = store.open_case(phone)
    first = not store.messages(case_id)

    for data, ctype, fname in media:
        if ctype.startswith("audio/"):
            said = ai.transcribe(data, fname)
            store.add_message(case_id, "in", "voice", said)
        else:
            os.makedirs(MEDIA_DIR, exist_ok=True)
            path = os.path.join(MEDIA_DIR, f"{case_id}-{int(time.time() * 1000)}-{fname}")
            with open(path, "wb") as f:
                f.write(data)
            ocr_text = ai.ocr(data, ctype)
            info = ai.classify_document(ocr_text)
            store.add_document(case_id, fname, ctype, path, info.get("categorie", "autre"),
                               info.get("resume", ""), ocr_text)
            note = f"[pièce reçue : {info.get('categorie', 'autre')}] {info.get('resume', '')}"
            store.add_message(case_id, "in", "document", note)

    if text:
        store.add_message(case_id, "in", "text", text)

    if first:
        _reply(case_id, phone, ai.CONSENT, send)
        return

    if text and text.strip().lower() in END_WORDS:
        return finish(case_id, phone, send)

    reply = ai.next_reply(store.messages(case_id))
    if "FIN_ACCUEIL" in reply:
        return finish(case_id, phone, send)
    _reply(case_id, phone, reply, send)


def finish(case_id: int, phone: str, send) -> None:
    case_file = ai.build_case_file(store.messages(case_id), store.documents(case_id))
    # >>> mcp_rogue gate goes here: conflict check on case_file["employeur"] before sending to the lawyer.
    store.close_case(case_id, case_file)
    summary = case_file.get("resume_client") or "Votre dossier a été transmis à l'avocat."
    _reply(case_id, phone, summary, send)


def _reply(case_id: int, phone: str, body: str, send):
    store.add_message(case_id, "out", "text", body)
    send(phone, body)


def case_view(case_id: int) -> dict:
    c = store.case(case_id)
    if not c:
        return {}
    c["file"] = json.loads(c["summary_json"]) if c.get("summary_json") else None
    c["messages"] = store.messages(case_id)
    c["documents"] = store.documents(case_id)
    return c
