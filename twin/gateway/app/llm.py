"""Client OpenAI-compatible minimal (Ollama, Gemini, Groq, OpenRouter…)."""

from __future__ import annotations

import asyncio
import logging
import re

import httpx

from .config import LLMEndpoint

log = logging.getLogger("twin.llm")
THINK_RE = re.compile(r"<think>.*?</think>\s*", re.S)


class LLMError(Exception):
    pass


class LLM:
    def __init__(self, endpoint: LLMEndpoint, http: httpx.AsyncClient, timeout: float = 120.0):
        self.ep = endpoint
        self.http = http
        self.timeout = timeout

    @property
    def model(self) -> str:
        return self.ep.models[0] if self.ep.models else ""

    async def chat(self, messages: list[dict], tools: list[dict] | None = None,
                   temperature: float = 0.6, max_tokens: int = 2048,
                   timeout: float | None = None, retries: int = 2) -> dict:
        """Retourne le message assistant ({content, tool_calls?}). Bascule sur
        les modèles de repli en cas de 429 (quota par modèle chez Gemini)."""
        if not self.ep.configured:
            raise LLMError(f"endpoint {self.ep.name} non configuré")
        body: dict = {"messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if self.ep.no_think:
            # Ollama : c'est reasoning_effort=none qui coupe la réflexion de Qwen3
            # (« think »: false est ignoré par l'endpoint OpenAI, « /no_think »
            # aussi). Mesuré : 1,5 s au lieu de 13 s pour un mot.
            body["reasoning_effort"] = "none"
        if tools:
            body["tools"] = tools
        headers = {"Authorization": f"Bearer {self.ep.key}", "Content-Type": "application/json",
                   "User-Agent": "twin-gateway/0.1"}
        url = self.ep.base.rstrip("/") + "/chat/completions"
        last: Exception | None = None
        waits = ((2, 5, None), (2, None), (None,))[max(0, min(2, 2 - retries))]
        for i, model in enumerate(self.ep.models):
            body["model"] = model
            for wait in waits:
                try:
                    r = await self.http.post(url, json=body, headers=headers,
                                             timeout=timeout or self.timeout)
                except httpx.HTTPError as e:
                    last = e
                    if wait is None:
                        break
                    await asyncio.sleep(wait)
                    continue
                if r.status_code == 429:
                    last = LLMError(f"429 sur {model}")
                    if i + 1 < len(self.ep.models):
                        log.warning("quota épuisé, repli", extra={"model": model, "next": self.ep.models[i + 1]})
                    break
                if r.status_code >= 500 and wait is not None:
                    last = LLMError(f"HTTP {r.status_code} sur {model}")
                    await asyncio.sleep(wait)
                    continue
                if r.status_code >= 400:
                    raise LLMError(f"HTTP {r.status_code} sur {model} : {r.text[:300]}")
                data = r.json()
                msg = data["choices"][0]["message"]
                if msg.get("content"):
                    msg["content"] = THINK_RE.sub("", msg["content"]).strip()
                msg["_model"] = model
                u = data.get("usage") or {}
                log.info("llm", extra={"model": model, "tokens": {
                    "prompt": u.get("prompt_tokens"), "completion": u.get("completion_tokens")}})
                return msg
        raise LLMError(str(last) if last else "aucun modèle n'a répondu")
