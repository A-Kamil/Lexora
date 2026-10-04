"""Deterministic control point on every agent tool call (inherited from mcp_rogue).

No model decides here. For each call: is the tool allowed for this agent? Do the arguments carry
client personal data to an external service? Decision: allow | redact | refuse. Every decision is
appended to a per-case journal chained by HMAC, so the lawyer can prove what the agents did.
"""
import hashlib
import hmac
import json
import os
import re
import time

from . import store

KEY = os.environ.get("LEXORA_JOURNAL_KEY", "dev-only-key").encode()

# tool -> (agents allowed to call it, external service?)
TOOLS = {
    "rechercher_textes":       ({"accueil", "chercheur"}, True),
    "consulter_article":       ({"accueil", "chercheur"}, True),
    "rechercher_jurisprudence": ({"accueil", "chercheur"}, True),
    "identifier_entreprise":   ({"accueil"}, True),
    "demander_recherche_juridique": ({"accueil"}, True),   # the sub-agent never sees client identity
    "noter_client":            ({"accueil"}, False),
    "etat_dossier":            ({"accueil"}, False),
    "rechercher_convention_edh": ({"chercheur"}, False),   # local official text, nothing leaves the machine
    "consulter_article_cedh":  ({"chercheur"}, False),
}

PHONE = re.compile(r"(\+?\d[\d .-]{7,}\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


def client_identifiers(case_id: int) -> list[str]:
    """Words that identify the client, taken from the case (phone, declared name)."""
    c = store.case(case_id) or {}
    ids = [c.get("phone", "").replace("whatsapp:", "")]
    ids += [w for w in (c.get("client_name") or "").split() if len(w) > 2]
    return [i for i in ids if i]


def check(case_id: int, agent: str, tool: str, args: dict) -> tuple[str, dict, str]:
    """Return (decision, args_to_use, reason)."""
    if tool not in TOOLS:
        return "refuse", args, "outil inconnu du registre"
    allowed, external = TOOLS[tool]
    if agent not in allowed:
        return "refuse", args, f"l'agent « {agent} » n'a pas accès à {tool}"
    if not external:
        return "allow", args, "outil interne"
    clean, hits = {}, []
    secrets = client_identifiers(case_id)
    for k, v in args.items():
        if not isinstance(v, str):
            clean[k] = v
            continue
        new = EMAIL.sub("[email retiré]", PHONE.sub("[numéro retiré]", v))
        for s in secrets:
            new = re.sub(re.escape(s), "[client]", new, flags=re.I)
        if new != v:
            hits.append(k)
        clean[k] = new
    if hits:
        return "redact", clean, f"données du client retirées avant envoi externe ({', '.join(hits)})"
    return "allow", clean, "aucune donnée du client dans la requête"


def record(case_id: int, agent: str, tool: str, args: dict, decision: str, reason: str, ms: int):
    prev = store.last_journal_hash(case_id) or ""
    entry = {"case_id": case_id, "ts": round(time.time(), 3), "agent": agent, "tool": tool,
             "args": args, "decision": decision, "reason": reason, "ms": ms, "prev": prev}
    h = hmac.new(KEY, json.dumps(entry, sort_keys=True, ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
    store.add_journal(case_id, entry, h)


def verify(case_id: int) -> bool:
    prev = ""
    for row in store.journal(case_id):
        entry = json.loads(row["entry_json"])
        if entry.get("prev") != prev:
            return False
        h = hmac.new(KEY, json.dumps(entry, sort_keys=True, ensure_ascii=False).encode(), hashlib.sha256).hexdigest()
        if h != row["hash"]:
            return False
        prev = h
    return True
