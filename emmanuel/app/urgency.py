"""Deterministic urgency classifier: same facts in, same decision out. No model decides here.

The case-file agent only EXTRACTS facts (dates, booleans, signals). This module applies the lawyer's
rules (app/data/urgence.json) and returns the level, the action (call today / within 48 h / written
answer) and every rule that fired, so the lawyer sees why.
"""
import datetime as dt
import json
import os
from pathlib import Path

RULES_PATH = Path(os.environ.get("LEXORA_URGENCE_RULES", Path(__file__).parent / "data" / "urgence.json"))


def rules() -> dict:
    return json.loads(RULES_PATH.read_text(encoding="utf-8"))


def _date(s):
    if not s or not isinstance(s, str):
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    return None


def today() -> dt.date:
    t = os.environ.get("LEXORA_TODAY")  # fixed date for demos and tests
    return _date(t) if t else dt.date.today()


def classify(facts: dict, r: dict | None = None) -> dict:
    r = r or rules()
    now = today()
    fired = []  # (level, rule_id, reason)

    entretien = _date(facts.get("date_entretien_prealable"))
    notif = _date(facts.get("date_notification"))

    if entretien and 0 <= (entretien - now).days <= r["entretien_imminent_jours"]:
        fired.append(("immediat", "R1", f"entretien préalable dans {(entretien - now).days} jour(s) ({entretien:%d/%m/%Y})"))
    if facts.get("mise_a_pied_conservatoire") is True:
        fired.append(("immediat", "R2", "mise à pied conservatoire en cours"))
    if facts.get("salarie_protege") is True:
        fired.append(("immediat", "R3", "salarié protégé (mandat représentatif)"))
    if notif:
        elapsed = (now - notif).days
        left = r["delai_contestation_jours"] - elapsed
        if left <= 0:
            fired.append(("immediat", "R4", f"délai de contestation de {r['delai_contestation_jours']} j dépassé ({elapsed} j écoulés) — "
                                            f"{r['delai_contestation_reference']}"))
        elif left <= r["alerte_avant_fin_delai_jours"]:
            fired.append(("immediat", "R4", f"fin du délai de contestation dans {left} j — {r['delai_contestation_reference']}"))
        elif elapsed <= r["notification_recente_jours"]:
            fired.append(("48h", "R6", f"licenciement notifié il y a {elapsed} j"))
    elif facts.get("type_rupture") in ("licenciement", "rupture_conventionnelle", "demission", None):
        fired.append(("48h", "R7", "date de notification inconnue : à obtenir"))
    signals = [s for s in (facts.get("signaux") or []) if s in r["signaux_48h"]]
    if signals:
        fired.append(("48h", "R5", "signaux sensibles : " + ", ".join(signals)))

    if not fired:
        fired.append(("normal", "R0", "aucune règle d'urgence déclenchée"))
    best = max(fired, key=lambda f: r["niveaux"][f[0]]["rang"])[0]
    return {
        "niveau": best,
        "action": r["niveaux"][best]["action"],
        "regles": [{"id": i, "niveau": lv, "motif": why} for lv, i, why in fired],
        "faits_utilises": {k: facts.get(k) for k in ("date_notification", "date_entretien_prealable", "type_rupture",
                                                     "mise_a_pied_conservatoire", "salarie_protege", "signaux")},
        "calcule_le": now.strftime("%d/%m/%Y"),
    }
