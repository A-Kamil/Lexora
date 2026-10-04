"""Convention européenne des droits de l'homme (+ protocoles): local official text supplied by the team's lawyer.

Source: sources/Convention_FRA.pdf (Cour européenne des droits de l'homme), parsed into app/data/cedh.json.
Local search, nothing leaves the machine.
"""
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "cedh.json"
STOP = set("le la les de des du un une et ou en au aux a à pour par sur dans que qui ne pas est son sa ses sont ce cette tout toute toutes".split())


def _norm(s: str) -> list[str]:
    s = unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()
    return [w for w in re.findall(r"[a-z]{3,}", s) if w not in STOP]


@lru_cache(maxsize=1)
def corpus() -> dict:
    return json.loads(DATA.read_text(encoding="utf-8"))


def _ref(a: dict) -> str:
    return f"CEDH art. {a['num']}" if a["instrument"] == "Convention" else f"{a['instrument']} à la CEDH, art. {a['num']}"


def search(question: str, n: int = 4) -> list[dict]:
    q = set(_norm(question))
    scored = []
    for a in corpus()["articles"]:
        title, body = set(_norm(a["titre"])), _norm(a["texte"])
        score = 3 * len(q & title) + sum(1 for w in body if w in q) / (1 + len(body) / 200)
        if score > 0:
            scored.append((score, a))
    scored.sort(key=lambda x: -x[0])
    return [{"reference": _ref(a), "titre": a["titre"], "extrait": a["texte"][:600]} for _, a in scored[:n]]


def get(num: int, instrument: str = "Convention") -> dict:
    for a in corpus()["articles"]:
        if a["num"] == int(num) and a["instrument"].lower() == instrument.lower():
            return {"reference": _ref(a), "titre": a["titre"], "texte": a["texte"][:4000]}
    return {"erreur": f"article {num} introuvable dans {instrument}"}
