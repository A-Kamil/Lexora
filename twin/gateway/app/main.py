"""Gateway FastAPI — point d'entrée unique du jumeau (texte pour l'instant)."""

from __future__ import annotations

import json
import logging
import sys
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .agent import Agent
from .config import GATEWAY_DIR, settings
from .hub import Hub
from .llm import LLM
from .manifests import load_connectors


class JSONLog(logging.Formatter):
    """Une ligne JSON par événement, champs « extra » inclus, jamais de contenu."""
    KEEP = {"tier", "route", "model", "reason", "tools", "facts", "ms", "err",
            "connector", "next", "timings", "tokens"}

    def format(self, rec):
        d = {"t": self.formatTime(rec, "%H:%M:%S"), "lvl": rec.levelname,
             "log": rec.name, "msg": rec.getMessage()}
        d.update({k: v for k, v in rec.__dict__.items() if k in self.KEEP})
        return json.dumps(d, ensure_ascii=False)


def setup_logging():
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(JSONLog())
    logging.basicConfig(level=logging.INFO, handlers=[h])
    for noisy in ("httpx", "httpx2", "httpcore", "mcp"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    s = settings()
    connectors = load_connectors(s.repo_root)
    http = httpx.AsyncClient()
    hub = Hub(connectors, timeout=s.llm_timeout)
    edge = LLM(s.edge, http, s.llm_timeout)
    external = LLM(s.external, http, s.llm_timeout) if s.external.configured else None
    persona = (GATEWAY_DIR / "prompts" / "persona.md").read_text(encoding="utf-8")
    persona_public = (GATEWAY_DIR / "prompts" / "persona_public.md").read_text(encoding="utf-8")
    app.state.settings = s
    app.state.hub = hub
    app.state.agent = Agent(s, hub, edge, external, persona, persona_public)
    logging.getLogger("twin").info("gateway prêt", extra={
        "model": edge.model, "route": "external:" + (external.model if external else "off"),
        "tools": [c.name for c in connectors]})
    try:
        yield
    finally:
        await http.aclose()


app = FastAPI(title="twin-gateway", version="0.1.0", lifespan=lifespan)


class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    history: list[Message] = Field(default_factory=list)
    voice: bool = False          # joindre la réponse synthétisée (audio_b64)
    language: str = "fr"


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    language: str = "fr"


async def synthesize(text: str, language: str) -> dict:
    """Étage de sortie : voix du jumeau via le connecteur voice_clone (T1, local)."""
    hub: Hub = app.state.hub
    if "voice_clone" not in hub.connectors:
        raise HTTPException(503, "connecteur voice_clone absent")
    try:
        r = json.loads(await hub.call("voice_clone", "speak", {"text": text, "language": language}))
    except Exception as e:
        logging.getLogger("twin").error("synthèse en échec", extra={"err": type(e).__name__})
        raise HTTPException(502, f"voice_clone : {type(e).__name__}: {e}")
    if "error" in r:
        raise HTTPException(502, f"voice_clone : {r['error']}")
    return r


@app.post("/chat")
async def chat(body: ChatIn):
    try:
        turn = await app.state.agent.respond(body.message, [m.model_dump() for m in body.history])
    except Exception as e:
        logging.getLogger("twin").error("tour en échec", extra={"err": type(e).__name__})
        raise HTTPException(502, f"{type(e).__name__}: {e}")
    out = turn.__dict__.copy()
    if body.voice and turn.answer:
        try:
            r = await synthesize(turn.answer, body.language)
            out["audio"] = {"b64": r["audio_b64"], "mime": r.get("mime", "audio/wav"), "ms": r.get("ms")}
        except HTTPException as e:  # la voix est un bonus : la réponse texte part quand même
            out["audio_error"] = e.detail
    return out


@app.post("/speak")
async def speak(body: SpeakIn):
    r = await synthesize(body.text, body.language)
    return {"audio_b64": r["audio_b64"], "mime": r.get("mime", "audio/wav"), "ms": r.get("ms"),
            "device": r.get("device"), "path": r.get("path")}


@app.get("/healthz")
async def healthz():
    s = app.state.settings
    return {"ok": True, "edge": s.edge.models[0], "external": s.external.models[0] if s.external.configured else None,
            "allow_external": s.allow_external, "connectors": await app.state.hub.status()}


@app.get("/tools")
async def tools():
    hub: Hub = app.state.hub
    out = []
    for name, c in hub.connectors.items():
        try:
            for t in await hub.tools(name):
                out.append({"connector": name, "tool": t.name, "tier": c.tier.name,
                            "read_only": c.tool_is_read_only(t.name, getattr(t, "annotations", None)),
                            "description": (t.description or "")[:200]})
        except Exception as e:
            out.append({"connector": name, "error": type(e).__name__})
    return out


@app.get("/connectors")
async def connectors():
    return await app.state.hub.status()
