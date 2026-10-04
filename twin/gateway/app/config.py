"""Configuration du gateway — lue UNIQUEMENT depuis l'environnement (et
gateway/.env, gitignoré). Aucune autre partie du code ne touche os.environ."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

GATEWAY_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT_DEFAULT = GATEWAY_DIR.parent


def load_env(path: Path = GATEWAY_DIR / ".env") -> None:
    """KEY=value ; ne remplace jamais une variable déjà présente."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class LLMEndpoint:
    name: str            # "edge" | "external" — apparaît dans les logs de routage
    base: str
    key: str
    models: tuple[str, ...]  # le 1er est nominal, les suivants sont des replis (429)
    no_think: bool = False   # Qwen3 & co : couper la « réflexion » (latence)

    @property
    def configured(self) -> bool:
        return bool(self.base and self.models)


@dataclass(frozen=True)
class Settings:
    listen: str
    repo_root: Path
    edge: LLMEndpoint
    external: LLMEndpoint
    allow_external: bool
    max_tool_rounds: int
    tool_result_max_chars: int
    facts_k: int
    style_k: int
    fact_chars: int   # longueur max d'un fait dans le prompt (coût en tokens edge)
    history_max: int
    llm_timeout: float


def _bool(key: str, default: bool) -> bool:
    v = os.environ.get(key)
    if v is None or not v.strip():
        return default
    return v.strip().lower() in ("1", "true", "yes", "on", "oui")


def _models(*keys: str) -> tuple[str, ...]:
    out: list[str] = []
    for k in keys:
        out += [m.strip() for m in os.environ.get(k, "").split(",") if m.strip()]
    return tuple(out)


def settings() -> Settings:
    load_env()
    env = os.environ.get
    return Settings(
        listen=env("TWIN_GW_LISTEN", "127.0.0.1:8080"),
        repo_root=Path(env("TWIN_REPO_ROOT", str(REPO_ROOT_DEFAULT))),
        edge=LLMEndpoint(
            name="edge",
            base=env("TWIN_EDGE_API_BASE", "http://127.0.0.1:11434/v1"),
            key=env("TWIN_EDGE_API_KEY", "ollama"),
            models=_models("TWIN_EDGE_MODEL") or ("qwen3:4b",),
            no_think=_bool("TWIN_EDGE_NO_THINK", True),
        ),
        external=LLMEndpoint(
            name="external",
            base=env("TWIN_EXT_API_BASE", ""),
            key=env("TWIN_EXT_API_KEY", ""),
            models=_models("TWIN_EXT_MODEL", "TWIN_EXT_MODEL_FALLBACK"),
        ),
        allow_external=_bool("TWIN_ROUTER_ALLOW_EXTERNAL", True),
        max_tool_rounds=int(env("TWIN_GW_MAX_TOOL_ROUNDS", "6")),
        tool_result_max_chars=int(env("TWIN_GW_TOOL_RESULT_MAX_CHARS", "6000")),
        facts_k=int(env("TWIN_GW_FACTS_K", "8")),
        style_k=int(env("TWIN_GW_STYLE_K", "6")),
        fact_chars=int(env("TWIN_GW_FACT_CHARS", "400")),
        history_max=int(env("TWIN_GW_HISTORY_MAX", "12")),
        llm_timeout=float(env("TWIN_GW_LLM_TIMEOUT", "120")),
    )
