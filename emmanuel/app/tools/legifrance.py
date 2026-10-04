"""Légifrance via PISTE: official texts in force. Never written from memory."""
import re
import time

from . import piste

BASE = "/dila/legifrance/lf-engine-app"
CODES = {  # LEGITEXT ids of the codes we use
    "travail": "LEGITEXT000006072050",
    "civil": "LEGITEXT000006070721",
    "securite_sociale": "LEGITEXT000006073189",
    "penal": "LEGITEXT000006070719",
}
_TAG = re.compile(r"<[^>]+>")


def _clean(html: str) -> str:
    return re.sub(r"\s+", " ", _TAG.sub(" ", html or "")).strip()


def get_article(code: str, num: str) -> dict:
    """Article in force, e.g. code='travail', num='L1232-1'."""
    text_id = CODES.get(code, code)
    j = piste.post(f"{BASE}/consult/getArticleWithIdAndNum", {"id": text_id, "num": num})
    a = j.get("article") or j
    return {
        "id": a.get("id"),
        "num": a.get("num", num),
        "code": code,
        "etat": a.get("etat"),
        "texte": _clean(a.get("texteHtml") or a.get("texte") or "")[:4000],
        "url": f"https://www.legifrance.gouv.fr/codes/article_lc/{a.get('id')}" if a.get("id") else None,
    }


def search(query: str, code: str = "travail", n: int = 5) -> list[dict]:
    """Full-text search in a code (version in force today). Returns article ids/nums with an extract."""
    body = {
        "fond": "CODE_DATE",
        "recherche": {
            "champs": [{"typeChamp": "ALL", "operateur": "ET",
                        "criteres": [{"typeRecherche": "UN_DES_MOTS", "valeur": query, "operateur": "ET"}]}],
            "filtres": [{"facette": "DATE_VERSION", "singleDate": int(time.time() * 1000)}]
            + ([{"facette": "NOM_CODE", "valeurs": [_code_name(code)]}] if code in CODES else []),
            "pageNumber": 1, "pageSize": n, "operateur": "ET", "sort": "PERTINENCE", "typePagination": "ARTICLE",
        },
    }
    j = piste.post(f"{BASE}/search", body)
    out = []
    for res in j.get("results", []):
        for sec in res.get("sections", []) or []:
            for ex in sec.get("extracts", []) or []:
                if str(ex.get("id", "")).startswith("LEGIARTI"):
                    out.append({"id": ex["id"], "num": ex.get("num"), "extrait": _clean(" ".join(ex.get("values") or []))[:500],
                                "url": f"https://www.legifrance.gouv.fr/codes/article_lc/{ex['id']}"})
    return out[:n]


def _code_name(code: str) -> str:
    return {"travail": "Code du travail", "civil": "Code civil",
            "securite_sociale": "Code de la sécurité sociale", "penal": "Code pénal"}[code]
