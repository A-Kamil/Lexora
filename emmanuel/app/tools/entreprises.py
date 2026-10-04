"""Annuaire des entreprises (api.gouv.fr, public, no key): identify the employer / opposing party."""
import httpx

URL = "https://recherche-entreprises.api.gouv.fr/search"


def search(name: str, n: int = 3) -> list[dict]:
    r = httpx.get(URL, params={"q": name, "per_page": n}, timeout=20)
    r.raise_for_status()
    out = []
    for e in r.json().get("results", [])[:n]:
        siege = e.get("siege") or {}
        out.append({
            "siren": e.get("siren"),
            "nom": e.get("nom_complet"),
            "adresse": siege.get("adresse"),
            "activite": e.get("activite_principale"),
            "effectif": e.get("tranche_effectif_salarie"),
            "etat": e.get("etat_administratif"),
            "convention_collective": (e.get("complements") or {}).get("liste_idcc"),
        })
    return out
