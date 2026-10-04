"""Tiers de confidentialité et classification d'une question.

T0 = connaissance générale (peut sortir de la machine)
T1 = personnel  (agenda, contacts, messages, projets, opinions) — edge seulement
T2 = sensible   (argent, santé, intime, identifiants) — edge, contenu jamais journalisé

Règle du CLAUDE.md : en cas de doute → edge. La classification tourne toujours
en local ; l'externe n'est jamais consulté pour décider s'il peut l'être.
"""

from __future__ import annotations

import re
from enum import IntEnum


class Tier(IntEnum):
    T0 = 0
    T1 = 1
    T2 = 2

    @classmethod
    def parse(cls, s: str, default: "Tier | None" = None) -> "Tier":
        s = (s or "").strip().upper()
        if s in cls.__members__:
            return cls[s]
        if default is None:
            raise ValueError(f"tier inconnu : {s!r}")
        return default


# Marqueurs lexicaux : volontairement larges, ils ne peuvent que monter le tier.
T2_RE = re.compile(
    r"\b(mot de passe|password|passe?word|iban|rib|carte (bancaire|bleue|de cr[ée]dit)|"
    r"salaire|paie|imp[ôo]ts?|dette|cr[ée]dit|pr[êe]t|banque|d[ée]couvert|argent|fric|thune|"
    r"m[ée]decin|ordonnance|maladie|sant[ée]|th[ée]rapie|psy|diagnostic|"
    r"sexe|sexuel|rupture|couple|copine|copain|ex\b|"
    r"token|cl[ée] api|secret|identifiant|login)\b", re.I)
T1_RE = re.compile(
    r"\b(whatsapp|instagram|insta|message|messages|conversation|discussion|"
    r"agenda|calendrier|rendez-vous|rdv|mail|gmail|contact|"
    r"mes|mon|ma|nos|notre|mien|mienne|m'|moi|je|j'|"
    r"tes|ton|ta|toi|tu|t')\b", re.I)

CLASSIFY_SYSTEM = (
    "Tu classes une question posée au jumeau numérique d'une personne. Réponds par "
    "UN SEUL mot : T0, T1 ou T2.\n"
    "T0 = connaissance générale, sans aucun lien avec la vie, les proches, les projets, "
    "les opinions ou les données de la personne (ex. « c'est quoi SASE ? », « capitale du "
    "Bénin ? »).\n"
    "T1 = concerne la personne : ses messages, contacts, agenda, projets, habitudes, "
    "avis, souvenirs, ou emploie « tu/toi/mes/mon » en s'adressant à elle.\n"
    "T2 = argent, santé, vie intime/sentimentale, identifiants ou secrets.\n"
    "Au moindre doute, réponds T1."
)


def rule_tier(question: str) -> Tier | None:
    """Tier imposé par les règles, ou None si les règles ne tranchent pas."""
    if T2_RE.search(question):
        return Tier.T2
    if T1_RE.search(question):
        return Tier.T1
    return None


async def classify(question: str, llm, allow_external: bool) -> tuple[Tier, str]:
    """(tier, raison). `llm` est le modèle EDGE (jamais l'externe)."""
    if not allow_external:
        return Tier.T1, "externe désactivé"
    ruled = rule_tier(question)
    if ruled is not None:
        return ruled, "règle lexicale"
    try:
        msg = await llm.chat(
            [{"role": "system", "content": CLASSIFY_SYSTEM},
             {"role": "user", "content": question}],
            temperature=0.0, max_tokens=8, timeout=30, retries=0)
        m = re.search(r"\bT[012]\b", (msg.get("content") or "").upper())
        if m:
            return Tier.parse(m.group(0)), "classifieur local"
        return Tier.T1, "classifieur illisible → doute"
    except Exception as e:  # modèle local absent : on ne bloque pas, on reste edge
        return Tier.T1, f"classifieur indisponible ({type(e).__name__})"
