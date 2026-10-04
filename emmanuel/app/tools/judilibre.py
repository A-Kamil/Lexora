"""Judilibre (Cour de cassation open data) via PISTE."""
from . import piste

BASE = "/cassation/judilibre/v1.0"


def search(query: str, n: int = 5) -> list[dict]:
    j = piste.get(f"{BASE}/search", {"query": query, "page_size": n, "resolve_references": "true"})
    out = []
    for r in j.get("results", [])[:n]:
        out.append({
            "id": r.get("id"),
            "juridiction": r.get("jurisdiction"),
            "chambre": r.get("chamber"),
            "date": r.get("decision_date"),
            "numero": r.get("number"),
            "solution": r.get("solution"),
            "resume": (r.get("summary") or " ".join(r.get("highlights", {}).get("text", [])[:2]) or "")[:600],
            "url": f"https://www.courdecassation.fr/decision/{r.get('id')}" if r.get("id") else None,
        })
    return out
