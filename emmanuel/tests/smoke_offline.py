import os, sys, json, types
for f in ("/tmp/lx.db",):
    if os.path.exists(f): os.remove(f)
os.environ.update(LEXORA_DB="/tmp/lx.db", LEXORA_MEDIA="/tmp/lxm", LEXORA_SKIP_SIGNATURE="1",
                  LEXORA_PUBLIC_URL="https://demo.example", PISTE_CLIENT_ID="x", PISTE_CLIENT_SECRET="y")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import ai, agents, store, policy
from app.tools import legifrance, entreprises, judilibre
ai.transcribe = lambda d, f: "Je m'appelle Jean Fictif, licencié par Boulangerie Fictive SARL le 12 septembre."
ai.ocr = lambda d, c: "LETTRE DE LICENCIEMENT pour faute grave"
ai.classify_document = lambda t: {"categorie": "lettre de licenciement", "resume": "Faute grave notifiée le 12/09/2026."}
legifrance.search = lambda q, code="travail", n=5: [{"id": "LEGIARTI000000000001", "num": "L1232-1", "extrait": "Tout licenciement ... cause réelle et sérieuse", "url": "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000000000001"}]
legifrance.get_article = lambda code, num: {"id": "LEGIARTI000000000002", "num": num, "code": code, "etat": "VIGUEUR", "texte": "texte officiel", "url": "u"}
entreprises.search = lambda n, k=3: [{"siren": "000000000", "nom": "BOULANGERIE FICTIVE", "adresse": "Paris"}]
judilibre.search = lambda q, n=5: []
ai.build_case_file = lambda h, d, s=None: {"client": "Jean Fictif", "employeur": "Boulangerie Fictive SARL", "faits": {"type_rupture": "licenciement", "date_notification": "12/09/2026"}, "urgence": {"niveau": "immediat", "action": "Appeler le client aujourd'hui", "raison": "mise à pied conservatoire en cours"},
    "textes_applicables": [{"reference": s[0]["title"], "apport": "cause réelle et sérieuse"}] if s else [], "resume_client": "Transmis. Ceci n'est pas un conseil juridique, votre avocat vous recontactera."}

# fake Mistral: scripted tool calls
def call(name, args, cid): return types.SimpleNamespace(id=cid, function=types.SimpleNamespace(name=name, arguments=args))
def resp(content=None, calls=None): return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=content, tool_calls=calls))])
script = {
  "accueil": [resp(calls=[call("noter_client", '{"nom":"Jean Fictif"}', "a1")]),
              resp(calls=[call("identifier_entreprise", '{"nom":"Boulangerie Fictive SARL"}{"x":1}', "a2")]),  # malformed glued JSON
              resp(calls=[call("demander_recherche_juridique", '{"question":"licenciement faute grave de Jean Fictif +33612345678"}', "a3")]),
              resp(content="Merci. Quel était votre poste ?")],
  "chercheur": [resp(calls=[call("rechercher_convention_edh", '{"question":"vie privée correspondance"}', "c0")]), resp(calls=[call("rechercher_textes", '{"question":"licenciement faute grave Jean Fictif","code":"travail"}', "c1")]),
                resp(calls=[call("rechercher_jurisprudence", '{"question":"faute grave"}', "c2")]),
                resp(content="Art. L1232-1 : cause réelle et sérieuse.")],
}
state = {"agent": "accueil"}
class FakeChat:
    def complete(self, **kw):
        sysmsg = kw["messages"][0]["content"]
        who = "chercheur" if "chercheur juridique" in sysmsg else "accueil"
        q = script[who]
        return q.pop(0) if q else resp(content="ok")
ai._client = types.SimpleNamespace(chat=FakeChat())

from fastapi.testclient import TestClient
from app.main import app
with TestClient(app) as c:
    c.post("/simu", data={"text": "Bonjour"})
    r = c.get("/simu"); assert "/depot/" in r.text, "upload link missing"
    c.post("/simu", data={"text": "OUI"})
    c.post("/simu", data={"text": ""}, files={"file": ("v.ogg", b"x", "audio/ogg")})
    cid = store.open_case("simu:+33600000000")
    tok = store.case(cid)["upload_token"]
    r = c.post(f"/depot/{tok}", files=[("files", ("lettre.pdf", b"%PDF", "application/pdf")), ("files", ("contrat.docx", b"PK", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))])
    assert r.status_code in (200, 303)
    j = store.journal(cid); decisions = [(json.loads(x["entry_json"])["agent"], json.loads(x["entry_json"])["tool"], json.loads(x["entry_json"])["decision"], json.loads(x["entry_json"])["args"]) for x in j]
    for d in decisions: print(d)
    red = [d for d in decisions if d[1] == "rechercher_textes"][0]
    assert red[2] == "redact" and "Jean" not in red[3]["question"], red
    assert policy.verify(cid)
    c.post("/simu", data={"text": "fin"})
    r = c.get(f"/avocat/{cid}"); assert "chaîne vérifiée" in r.text and "L1232-1" in r.text and "caviardé" in r.text
    assert [x for x in c.get("/api/cases").json() if x["id"] == cid][0]["employeur"]
    assert "upload_token" not in c.get(f"/api/cases/{cid}").json()
    # tamper -> chain broken
    import sqlite3; con = sqlite3.connect("/tmp/lx.db"); con.execute("UPDATE journal SET entry_json=replace(entry_json,'allow','refuse') WHERE id=1"); con.commit()
    assert not policy.verify(cid)
    # new session command
    c.post("/simu", data={"text": "nouveau dossier"}); assert store.open_case("simu:+33600000000") != cid
    # refused tool for wrong agent
    d, _, why = policy.check(cid, "chercheur", "identifier_entreprise", {"nom": "x"}); assert d == "refuse"
print("smoke2 OK")
os.environ["LEXORA_TODAY"] = "04/10/2026"
with TestClient(app) as c:
    r = c.get(f"/avocat/{cid}/recap.md")
    assert r.status_code == 200 and "Urgence : immediat" in r.text and "mise à pied" in r.text and "Toutes les sources" in r.text, r.text[:400]
    assert [x for x in c.get("/api/cases").json() if x["id"] == cid][0]["urgence"] == "immediat"
print("recap OK")
