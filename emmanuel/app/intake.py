"""Channel-independent intake logic: used by the Twilio webhook, the offline simulator and the upload page."""
import json
import os
import threading
import time
from collections import defaultdict

from . import agents, ai, policy, store

MEDIA_DIR = os.environ.get("LEXORA_MEDIA", "data/media")
PUBLIC_URL = os.environ.get("LEXORA_PUBLIC_URL", "").rstrip("/")
END_WORDS = {"fin", "terminé", "termine", "c'est tout", "stop"}
NEW_WORDS = {"nouveau dossier", "nouveau", "recommencer"}
_locks = defaultdict(threading.Lock)  # one conversation turn at a time per phone


def upload_link(case_id: int) -> str | None:
    c = store.case(case_id)
    return f"{PUBLIC_URL}/depot/{c['upload_token']}" if PUBLIC_URL and c and c.get("upload_token") else None


def handle(phone: str, text: str, media: list[tuple[bytes, str, str]], send) -> None:
    """media = [(bytes, content_type, filename)]; send(to, body) delivers a reply on the channel."""
    with _locks[phone]:
        if text and text.strip().lower() in NEW_WORDS:
            case_id = store.new_case(phone)
            text = ""
        else:
            case_id = store.open_case(phone)
        first = not store.messages(case_id)

        for data, ctype, fname in media:
            add_media(case_id, data, ctype, fname)

        if text:
            store.add_message(case_id, "in", "text", text)

        if first:
            link = upload_link(case_id)
            body = ai.CONSENT + (f"\nVous pouvez aussi déposer vos documents ici : {link}" if link else "")
            return _reply(case_id, phone, body, send)

        if text and text.strip().lower() in END_WORDS:
            return finish(case_id, phone, send)

        reply = agents.accueil(case_id)
        if "FIN_ACCUEIL" in reply:
            return finish(case_id, phone, send)
        _reply(case_id, phone, reply, send)


def add_media(case_id: int, data: bytes, ctype: str, fname: str) -> None:
    """Voice -> Voxtral transcript. Document -> OCR -> classification + summary (document analyst)."""
    t0 = time.time()
    if ctype.startswith("audio/"):
        said = ai.transcribe(data, fname)
        store.add_message(case_id, "in", "voice", said)
        policy.record(case_id, "transcription", "voxtral", {"fichier": fname}, "allow", "vocal du client", int((time.time() - t0) * 1000))
        return
    os.makedirs(MEDIA_DIR, exist_ok=True)
    path = os.path.join(MEDIA_DIR, f"{case_id}-{int(time.time() * 1000)}-{os.path.basename(fname)}")
    with open(path, "wb") as f:
        f.write(data)
    ocr_text = ai.ocr(data, ctype)
    info = ai.classify_document(ocr_text)
    store.add_document(case_id, fname, ctype, path, info.get("categorie", "autre"), info.get("resume", ""), ocr_text)
    store.add_message(case_id, "in", "document", f"[pièce reçue : {info.get('categorie', 'autre')}] {info.get('resume', '')}")
    policy.record(case_id, "analyste_pieces", "ocr+classement", {"fichier": fname, "type": ctype}, "allow",
                  f"pièce classée : {info.get('categorie', 'autre')}", int((time.time() - t0) * 1000))


def finish(case_id: int, phone: str, send) -> None:
    t0 = time.time()
    case_file = ai.build_case_file(store.messages(case_id), store.documents(case_id), store.sources(case_id))
    # Urgency: model assessment against the firm's criteria (app/data/criteres_urgence.md), shown as such.
    u = case_file.get("urgence") if isinstance(case_file.get("urgence"), dict) else {}
    u.setdefault("niveau", "48h")
    u.setdefault("action", "Rappeler le client sous 48 h")
    u.setdefault("raison", "évaluation automatique indisponible : à qualifier par l'avocat")
    case_file["urgence"] = u
    policy.record(case_id, "qualification", "evaluation_urgence", {"niveau": u["niveau"]}, "allow",
                  u["raison"], int((time.time() - t0) * 1000))
    # >>> conflict check on case_file["employeur"] against the firm's client list goes here (mcp_rogue gate).
    store.close_case(case_id, case_file)
    policy.record(case_id, "qualification", "transmission_avocat", {"dossier": case_id}, "allow",
                  "fiche transmise à la plateforme avocat", 0)
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
    c["sources"] = store.sources(case_id)
    c["journal"] = [dict(json.loads(r["entry_json"]), hash=r["hash"][:12]) for r in store.journal(case_id)]
    c["journal_ok"] = policy.verify(case_id)
    return c


def recap_markdown(case_id: int) -> str:
    """Everything the lawyer needs, traceable: case, urgency and why, documents, sources, agent actions."""
    c = case_view(case_id)
    if not c:
        return ""
    f = c.get("file") or {}
    u = f.get("urgence") or {}
    L = [f"# Dossier {c['id']} — {f.get('client') or c.get('client_name') or c['phone']}", ""]
    if u:
        L += [f"**Urgence : {u.get('niveau')}** — {u.get('action')}", "", f"Raison : {u.get('raison')} (évaluation du modèle, à confirmer par l'avocat)", ""]
    L += [f"**Employeur :** {f.get('employeur') or '—'}", "", f.get("resume_faits") or "", "", "## Chronologie", ""]
    L += [f"- {e.get('date')} : {e.get('evenement')}" for e in f.get("chronologie") or []] + ["", "## Pièces reçues", ""]
    L += [f"- [{d['category']}] {d['filename']} — {d['summary']}" for d in c["documents"]] or ["- aucune"]
    L += ["", "## Textes applicables (trouvés par les agents)", ""]
    L += [f"- {t.get('reference')} — {t.get('apport')}" for t in f.get("textes_applicables") or []]
    L += ["", "## Toutes les sources consultées pendant l'échange", ""]
    L += [f"- [{s['kind']}] {s['title']}" + (f" — {s['url']}" if s.get("url") else "") for s in c["sources"]] or ["- aucune"]
    L += ["", "## Questions pour l'avocat", ""] + [f"- {q}" for q in f.get("questions_pour_l_avocat") or []]
    L += ["", "## Pièces manquantes", ""] + [f"- {p}" for p in f.get("pieces_manquantes") or []]
    L += ["", f"## Journal des agents ({'chaîne vérifiée' if c['journal_ok'] else 'CHAÎNE ROMPUE'})", "",
          "| Heure | Agent | Action | Décision | Motif |", "|---|---|---|---|---|"]
    L += [f"| {time.strftime('%H:%M:%S', time.localtime(j['ts']))} | {j['agent']} | {j['tool']} | {j['decision']} | {j['reason']} |"
          for j in c["journal"]]
    L += ["", "## Conversation WhatsApp", ""]
    L += [f"- **{'Client' if m['direction'] == 'in' else 'Accueil'}** ({m['kind']}) : {m['text']}" for m in c["messages"]]
    return "\n".join(L) + "\n"
