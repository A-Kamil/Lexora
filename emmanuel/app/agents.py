"""Agents (Mistral function calling). Every tool call goes through policy.check before it runs.

accueil   : the main agent talking to the client on WhatsApp. Qualifies, never advises.
chercheur : sub-agent called by accueil during the conversation. Searches official sources
            (Légifrance, Judilibre) and returns cited texts for the lawyer's case file.
The document analyst (OCR + classification) and the case-file builder live in ai.py.
"""
import json
import time

from . import ai, policy, store
from .tools import cedh, entreprises, judilibre, legifrance, piste

MAX_ROUNDS = 4


def _fn(name, desc, props, required):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props, "required": required}}}


ACCUEIL_TOOLS = [
    _fn("demander_recherche_juridique",
        "Demande au chercheur juridique les textes officiels et la jurisprudence utiles au dossier. "
        "Ne mets jamais le nom ni les coordonnées du client dans la question.",
        {"question": {"type": "string", "description": "question juridique générale, ex. 'licenciement pour faute grave procédure'"}},
        ["question"]),
    _fn("identifier_entreprise", "Identifie l'employeur ou la partie adverse dans l'annuaire officiel des entreprises.",
        {"nom": {"type": "string"}}, ["nom"]),
    _fn("noter_client", "Enregistre le nom du client dès qu'il le donne (sert à protéger ses données).",
        {"nom": {"type": "string"}}, ["nom"]),
    _fn("etat_dossier", "Liste les pièces reçues et les sources déjà trouvées.", {}, []),
]

CHERCHEUR_TOOLS = [
    _fn("rechercher_textes", "Recherche plein texte dans un code en vigueur (Légifrance).",
        {"question": {"type": "string"},
         "code": {"type": "string", "enum": ["travail", "civil", "securite_sociale", "penal"]}}, ["question"]),
    _fn("consulter_article", "Texte officiel en vigueur d'un article, ex. code='travail', num='L1232-1'.",
        {"code": {"type": "string", "enum": ["travail", "civil", "securite_sociale", "penal"]},
         "num": {"type": "string"}}, ["code", "num"]),
    _fn("rechercher_jurisprudence", "Décisions de la Cour de cassation (Judilibre).",
        {"question": {"type": "string"}}, ["question"]),
    _fn("rechercher_convention_edh", "Recherche dans la Convention européenne des droits de l'homme et ses protocoles "
        "(texte officiel fourni par le juriste) : vie privée, procès équitable, discrimination, liberté d'expression…",
        {"question": {"type": "string"}}, ["question"]),
    _fn("consulter_article_cedh", "Texte d'un article de la Convention EDH ou d'un protocole.",
        {"num": {"type": "integer"},
         "instrument": {"type": "string", "description": "'Convention' (défaut), 'Protocole additionnel', 'Protocole n° 4', 'Protocole n° 12'…"}},
        ["num"]),
]

CHERCHEUR_SYSTEM = """Tu es le chercheur juridique d'un cabinet d'avocats (droit du travail).
On te pose une question générale. Utilise les outils pour trouver les articles en vigueur (Légifrance),
si utile 1 ou 2 décisions (Judilibre), et la Convention EDH quand un droit fondamental est en jeu
(vie privée, procès équitable, discrimination, liberté d'expression ou syndicale). Ne cite QUE ce que les outils ont renvoyé, jamais de mémoire.
Réponds en 5 lignes max : les références (article, décision) et en une phrase ce que chacune apporte."""


def _args(raw: str) -> dict:
    """Tolerate malformed function arguments (e.g. two JSON objects glued together)."""
    try:
        return json.loads(raw or "{}")
    except json.JSONDecodeError:
        obj, _ = json.JSONDecoder().raw_decode((raw or "{}").strip())
        return obj


def _run_tool(case_id: int, agent: str, name: str, args: dict) -> str:
    t0 = time.time()
    decision, args, reason = policy.check(case_id, agent, name, args)
    if decision == "refuse":
        policy.record(case_id, agent, name, args, decision, reason, int((time.time() - t0) * 1000))
        return json.dumps({"refus": reason}, ensure_ascii=False)
    try:
        out = _execute(case_id, name, args)
    except Exception as e:  # an unavailable source must not break the conversation
        out = {"erreur": f"source indisponible ({type(e).__name__})"}
        reason += " ; source indisponible"
    policy.record(case_id, agent, name, args, decision, reason, int((time.time() - t0) * 1000))
    return ai.wrap(name.upper(), json.dumps(out, ensure_ascii=False)[:6000])


def _execute(case_id: int, name: str, a: dict):
    if name == "demander_recherche_juridique":
        return {"synthese": chercheur(case_id, a["question"])}
    if name == "identifier_entreprise":
        res = entreprises.search(a["nom"])
        for e in res[:1]:
            store.add_source(case_id, "entreprise", e["siren"], e["nom"],
                             f"https://annuaire-entreprises.data.gouv.fr/entreprise/{e['siren']}", e.get("adresse"))
        return res
    if name == "noter_client":
        store.set_client_name(case_id, a["nom"])
        return {"ok": True}
    if name == "etat_dossier":
        return {"pieces": [{"categorie": d["category"], "resume": d["summary"]} for d in store.documents(case_id)],
                "sources": [s["title"] for s in store.sources(case_id)]}
    if name == "rechercher_convention_edh":
        res = cedh.search(a["question"])
        for r in res:
            store.add_source(case_id, "convention", r["reference"], f"{r['reference']} — {r['titre']}", None, r["extrait"])
        return res
    if name == "consulter_article_cedh":
        art = cedh.get(a["num"], a.get("instrument", "Convention"))
        if "reference" in art:
            store.add_source(case_id, "convention", art["reference"], f"{art['reference']} — {art['titre']}", None, art["texte"][:500])
        return art
    if not piste.configured():
        return {"erreur": "Légifrance non configuré (PISTE_CLIENT_ID / PISTE_CLIENT_SECRET)"}
    if name == "rechercher_textes":
        res = legifrance.search(a["question"], a.get("code", "travail"))
        for r in res:
            store.add_source(case_id, "article", r["id"], f"Article {r.get('num') or r['id']}", r["url"], r["extrait"])
        return res
    if name == "consulter_article":
        art = legifrance.get_article(a["code"], a["num"])
        store.add_source(case_id, "article", art["id"], f"Article {art['num']} ({a['code']})", art["url"], art["texte"][:500])
        return art
    if name == "rechercher_jurisprudence":
        res = judilibre.search(a["question"])
        for r in res:
            store.add_source(case_id, "decision", r["id"], f"Cass. {r.get('chambre') or ''} {r.get('date') or ''} n° {r.get('numero') or ''}",
                             r["url"], r["resume"])
        return res
    raise ValueError(name)


def _loop(case_id: int, agent: str, messages: list, tools: list) -> str:
    for _ in range(MAX_ROUNDS):
        res = ai.client().chat.complete(model=ai.CHAT_MODEL, temperature=0.2, messages=messages,
                                        tools=tools, tool_choice="auto", parallel_tool_calls=False)
        msg = res.choices[0].message
        calls = msg.tool_calls or []
        if not calls:
            return (msg.content or "").strip()
        messages.append({"role": "assistant", "content": msg.content or "", "tool_calls": [
            {"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}}
            for c in calls]})
        for c in calls:
            out = _run_tool(case_id, agent, c.function.name, _args(c.function.arguments))
            messages.append({"role": "tool", "name": c.function.name, "content": out, "tool_call_id": c.id})
    # out of rounds: ask for a plain answer
    res = ai.client().chat.complete(model=ai.CHAT_MODEL, temperature=0.2, messages=messages)
    return (res.choices[0].message.content or "").strip()


def chercheur(case_id: int, question: str) -> str:
    msgs = [{"role": "system", "content": CHERCHEUR_SYSTEM}, {"role": "user", "content": question}]
    return _loop(case_id, "chercheur", msgs, CHERCHEUR_TOOLS)


def accueil(case_id: int) -> str:
    msgs = [{"role": "system", "content": ai.SYSTEM}]
    for m in store.messages(case_id):
        if m["direction"] == "in":
            msgs.append({"role": "user", "content": ai.wrap("CLIENT", m["text"])})
        else:
            msgs.append({"role": "assistant", "content": m["text"]})
    return _loop(case_id, "accueil", msgs, ACCUEIL_TOOLS)
