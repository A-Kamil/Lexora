"""Un tour de conversation : classer → router → (mémoire) → boucle d'outils → réponse.

Journalise la décision de routage (tier, modèle, outils, latences), jamais le
contenu — règle CLAUDE.md, valable a fortiori en T2."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

from .config import Settings
from .hub import Hub, ToolError
from .llm import LLM
from .prompt import system_prompt, wrap_tool_result
from .tiers import Tier, classify

log = logging.getLogger("twin.route")


@dataclass
class Turn:
    answer: str
    tier: str
    model: str
    route: str                 # "edge" | "external"
    reason: str
    tools_called: list[str] = field(default_factory=list)
    facts: int = 0
    ms: int = 0
    timings: dict = field(default_factory=dict)   # classify / recall / llm / tools (ms)


class Agent:
    def __init__(self, settings: Settings, hub: Hub, edge: LLM, external: LLM | None,
                 persona: str, persona_public: str):
        self.s = settings
        self.hub = hub
        self.edge = edge
        self.external = external
        self.persona = persona
        self.persona_public = persona_public

    # ---- mémoire (connecteur « memory », optionnel : le jumeau répond sans) ----

    async def _recall(self, query: str) -> tuple[list[dict], list[str], dict]:
        facts, styles, profile = [], [], {}
        if "memory" not in self.hub.connectors:
            return facts, styles, profile
        try:
            r = json.loads(await self.hub.call("memory", "recall", {"question": query, "k": self.s.facts_k}))
            facts = r.get("facts", [])
        except Exception as e:
            log.warning("mémoire indisponible (recall)", extra={"err": type(e).__name__})
        try:
            r = json.loads(await self.hub.call("memory", "style_samples", {"k": self.s.style_k}))
            styles, profile = r.get("samples", []), r.get("profile", {})
        except Exception as e:
            log.warning("mémoire indisponible (style)", extra={"err": type(e).__name__})
        return facts, styles, profile

    # ---- tour complet ----

    async def respond(self, question: str, history: list[dict] | None = None) -> Turn:
        t0 = time.monotonic()
        timings: dict[str, int] = {}

        def lap(name: str, since: float) -> None:
            timings[name] = timings.get(name, 0) + int((time.monotonic() - since) * 1000)

        history = (history or [])[-self.s.history_max:]
        t = time.monotonic()
        tier, reason = await classify(question, self.edge, self.s.allow_external)
        lap("classify", t)
        external_ok = (tier == Tier.T0 and self.s.allow_external
                       and self.external is not None and self.external.ep.configured)

        if external_ok:
            llm, route = self.external, "external"
            system = system_prompt(self.persona_public, None, [], None, tools=False)
            tools, index, facts = [], {}, []
        else:
            llm, route = self.edge, "edge"
            # Relance elliptique en chat : on complète la requête de RETRIEVAL
            # avec la question précédente (pas la question envoyée au modèle).
            prev = [m["content"] for m in history if m.get("role") == "user"]
            query = (prev[-1] + " " + question) if prev and len(question) < 60 else question
            t = time.monotonic()
            facts, styles, profile = await self._recall(query)
            lap("recall", t)
            names = [n for n, c in self.hub.connectors.items() if n != "memory" and c.llm_tools]
            tools, index = await self.hub.openai_tools(names, allow_write=False)
            system = system_prompt(self.persona, profile, styles, facts, tools=bool(tools),
                                   fact_chars=self.s.fact_chars)

        messages = [{"role": "system", "content": system}, *history,
                    {"role": "user", "content": question}]
        tools_called: list[str] = []
        answer, model = "", llm.model

        for _ in range(self.s.max_tool_rounds):
            t = time.monotonic()
            msg = await llm.chat(messages, tools or None,
                                 timeout=self.s.llm_timeout if route == "edge" else 60)
            lap("llm", t)
            model = msg.get("_model", model)
            calls = msg.get("tool_calls") or []
            if not calls:
                answer = msg.get("content") or ""
                break
            messages.append({"role": "assistant",
                             **{k: v for k, v in msg.items() if not k.startswith("_")}})
            for tc in calls:
                fn = tc.get("function", {})
                qname = fn.get("name", "")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                tools_called.append(qname)
                hit = index.get(qname)
                if hit is None:
                    payload = f"erreur : outil inconnu ou non autorisé ({qname})"
                    cname, tname = "gateway", "refus"
                else:
                    c, t = hit
                    cname, tname = c.name, t.name
                    t_tool = time.monotonic()
                    try:
                        payload = await self.hub.call(c.name, t.name, args)
                    except (ToolError, Exception) as e:  # l'outil échoue, pas le tour
                        payload = f"erreur outil : {e}"
                    lap("tools", t_tool)
                messages.append({"role": "tool", "tool_call_id": tc.get("id", qname),
                                 "content": wrap_tool_result(cname, tname, payload,
                                                             self.s.tool_result_max_chars)})
        else:
            # Trop de tours : on force une réponse sans outils.
            msg = await llm.chat(messages, None)
            answer = msg.get("content") or ""

        ms = int((time.monotonic() - t0) * 1000)
        log.info("tour", extra={"tier": tier.name, "route": route, "model": model,
                                "reason": reason, "tools": tools_called,
                                "facts": len(facts), "ms": ms, "timings": timings})
        return Turn(answer=answer, tier=tier.name, model=model, route=route, reason=reason,
                    tools_called=tools_called, facts=len(facts), ms=ms, timings=timings)
