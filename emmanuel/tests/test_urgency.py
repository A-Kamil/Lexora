"""Deterministic urgency rules: same facts, same decision. Run: python3 tests/test_urgency.py"""
import os, sys
os.environ["LEXORA_TODAY"] = "04/10/2026"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.urgency import classify

def lvl(f): return classify(f)["niveau"]

assert lvl({"type_rupture": "licenciement", "date_notification": "12/09/2026"}) == "48h"                 # R6 recent
assert lvl({"date_entretien_prealable": "08/10/2026"}) == "immediat"                                     # R1 imminent
assert lvl({"date_notification": "01/01/2026", "mise_a_pied_conservatoire": True}) == "immediat"         # R2
assert lvl({"date_notification": "20/09/2025"}) == "immediat"                                            # R4 deadline close
assert lvl({"date_notification": "01/06/2026", "type_rupture": "licenciement"}) == "normal"               # old enough, far from deadline
assert lvl({"date_notification": "01/06/2026", "signaux": ["harcelement"]}) == "48h"                     # R5
assert lvl({"type_rupture": "licenciement"}) == "48h"                                                     # R7 unknown date
r = classify({"date_notification": "20/09/2025", "salarie_protege": True})
assert [x["id"] for x in r["regles"]] == ["R3", "R4"] and r["action"].startswith("Appeler")
assert classify({"date_notification": "12/09/2026"}) == classify({"date_notification": "12/09/2026"})    # deterministic
print("urgency OK")
