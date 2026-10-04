"""Registre des connecteurs, construit depuis mcp/*/manifest.json.

Le manifeste est le contrat : tier, mode (read|write), hitl, et comment
joindre le serveur MCP. Le gateway ne connaît aucun connecteur en dur."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from .tiers import Tier


@dataclass(frozen=True)
class Connector:
    name: str
    tier: Tier
    mode: str                 # "read" | "write"
    hitl: bool
    endpoint: str             # URL MCP Streamable HTTP
    tools_meta: dict = field(default_factory=dict)  # nom -> {read_only, hitl, …}
    path: Path | None = None
    llm_tools: bool = True    # False = étage technique (TTS…), jamais offert au modèle

    def tool_is_read_only(self, tool_name: str, annotations=None) -> bool:
        meta = self.tools_meta.get(tool_name)
        if meta and "read_only" in meta:
            return bool(meta["read_only"])
        if annotations is not None:
            ro = getattr(annotations, "read_only_hint", None)
            if ro is None:
                ro = getattr(annotations, "readOnlyHint", None)
            if ro is not None:
                return bool(ro)
        return self.mode == "read"


def resolve_endpoint(m: dict) -> str:
    """endpoint_env (host:port ou URL) prime sur endpoint_default."""
    env = m.get("endpoint_env")
    v = os.environ.get(env, "").strip() if env else ""
    if not v:
        return m.get("endpoint_default", "")
    if not v.startswith("http"):
        v = "http://" + v
    if v.count("/") < 3:  # pas de chemin
        v = v.rstrip("/") + "/mcp"
    return v


def load_connectors(repo_root: Path) -> list[Connector]:
    out: list[Connector] = []
    for mf in sorted((repo_root / "mcp").glob("*/manifest.json")):
        m = json.loads(mf.read_text(encoding="utf-8"))
        out.append(Connector(
            name=m["name"],
            tier=Tier.parse(m.get("tier", "T1"), Tier.T1),
            mode=m.get("mode", "read"),
            hitl=bool(m.get("hitl", True)),
            endpoint=resolve_endpoint(m),
            tools_meta=m.get("tools", {}),
            path=mf.parent,
            llm_tools=bool(m.get("llm_tools", True)),
        ))
    return out
