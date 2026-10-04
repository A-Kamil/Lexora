"""Hub MCP : un client par connecteur, découverte des outils, appels.

Chaque appel ouvre une session (serveurs stateless sur loopback : coût
négligeable) — pas de connexion longue à surveiller."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from mcp.client import Client

from .manifests import Connector

log = logging.getLogger("twin.hub")


class ToolError(Exception):
    pass


class Hub:
    def __init__(self, connectors: list[Connector], tools_ttl: float = 60.0, timeout: float = 60.0):
        self.connectors = {c.name: c for c in connectors}
        self.tools_ttl = tools_ttl
        self.timeout = timeout
        self._tools_cache: dict[str, tuple[float, list]] = {}

    def get(self, name: str) -> Connector:
        try:
            return self.connectors[name]
        except KeyError:
            raise ToolError(f"connecteur inconnu : {name}")

    async def tools(self, name: str) -> list:
        """Outils déclarés par le serveur MCP (mis en cache tools_ttl s)."""
        hit = self._tools_cache.get(name)
        if hit and time.monotonic() - hit[0] < self.tools_ttl:
            return hit[1]
        c = self.get(name)
        async with Client(c.endpoint, read_timeout_seconds=self.timeout) as client:
            res = await client.list_tools()
        self._tools_cache[name] = (time.monotonic(), list(res.tools))
        return self._tools_cache[name][1]

    async def call(self, name: str, tool: str, args: dict | None = None) -> str:
        """Résultat textuel (JSON du structured_content s'il existe)."""
        c = self.get(name)
        async with Client(c.endpoint, read_timeout_seconds=self.timeout) as client:
            res = await client.call_tool(tool, args or {})
        texts = [getattr(b, "text", "") for b in (res.content or []) if getattr(b, "text", None)]
        if res.is_error:
            raise ToolError("; ".join(texts) or "erreur outil")
        if res.structured_content is not None:
            return json.dumps(res.structured_content, ensure_ascii=False)
        return "\n".join(texts)

    async def status(self) -> dict:
        async def one(c: Connector):
            try:
                tools = await asyncio.wait_for(self.tools(c.name), timeout=5)
                return c.name, {"reachable": True, "tier": c.tier.name, "mode": c.mode,
                                "hitl": c.hitl, "tools": len(tools), "endpoint": c.endpoint}
            except Exception as e:
                return c.name, {"reachable": False, "tier": c.tier.name, "mode": c.mode,
                                "hitl": c.hitl, "error": type(e).__name__, "endpoint": c.endpoint}
        return dict(await asyncio.gather(*(one(c) for c in self.connectors.values())))

    async def openai_tools(self, names: list[str], allow_write: bool = False):
        """Schémas OpenAI « function » + index nom_qualifié -> (connecteur, outil).

        Les outils d'écriture sont exclus tant que le HITL n'existe pas : le
        modèle ne doit même pas savoir qu'ils existent."""
        schemas, index = [], {}
        for name in names:
            c = self.get(name)
            if not c.llm_tools:
                continue
            try:
                tools = await self.tools(name)
            except Exception as e:
                log.warning("connecteur injoignable", extra={"connector": name, "err": type(e).__name__})
                continue
            for t in tools:
                if not allow_write and not c.tool_is_read_only(t.name, getattr(t, "annotations", None)):
                    continue
                q = f"{c.name}__{t.name}"
                params = getattr(t, "input_schema", None) or getattr(t, "inputSchema", None) or {"type": "object"}
                schemas.append({"type": "function", "function": {
                    "name": q, "description": (t.description or "")[:1024], "parameters": params}})
                index[q] = (c, t)
        return schemas, index
