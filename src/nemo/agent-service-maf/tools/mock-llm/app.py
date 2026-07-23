"""Deterministic mock LLM gateway for Bruno + e2e tests (plan I4 Mode A).

A tiny FastAPI app exposing the Bifrost-compatible
``POST /v1/chat/completions`` endpoint. Returns canned responses from
``fixtures.yaml`` keyed by substring match on the user's last input
message. Use this sidecar to make Bruno assertions deterministic --
the real Bifrost / LLM provider is too noisy to assert against.

Run locally::

    uvicorn app:app --host 0.0.0.0 --port 4000

Docker::

    docker compose -f bruno/docker-compose.bruno.yaml up mock-llm

Wire MAF to it by setting ``AGENT_GATEWAY__URL=http://mock-llm:4000/v1``.

This service intentionally has zero dependencies beyond FastAPI +
PyYAML so the Docker image stays under 100 MB and starts in <1s.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

FIXTURES_PATH = Path(os.environ.get("MOCK_LLM_FIXTURES", "/app/fixtures.yaml"))

#: Reply used when no fixture rule matches. Configurable so tests can
#: catch "I forgot to seed a fixture" instead of getting a generic
#: default that silently passes a wrong assertion.
DEFAULT_REPLY = os.environ.get(
    "MOCK_LLM_DEFAULT_REPLY",
    "MOCK_LLM_NO_FIXTURE_MATCHED",
)


def _load_fixtures() -> list[dict[str, Any]]:
    """Read ``fixtures.yaml`` once. The file is reloaded on every
    request when ``MOCK_LLM_HOT_RELOAD=1`` is set, so editing fixtures
    during a dev loop takes effect without a container restart.
    """
    if not FIXTURES_PATH.exists():
        return []
    raw = yaml.safe_load(FIXTURES_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        return []
    return raw


_FIXTURES_CACHE: list[dict[str, Any]] = []


def _fixtures() -> list[dict[str, Any]]:
    global _FIXTURES_CACHE
    if os.environ.get("MOCK_LLM_HOT_RELOAD") == "1" or not _FIXTURES_CACHE:
        _FIXTURES_CACHE = _load_fixtures()
    return _FIXTURES_CACHE


def _pick_response(user_text: str) -> str:
    """Find the first fixture whose ``match_input`` substring is in
    the user's last message and return its ``response`` payload.
    Returns :data:`DEFAULT_REPLY` when nothing matches.
    """
    lowered = (user_text or "").lower()
    for rule in _fixtures():
        marker = str(rule.get("match_input", "")).lower()
        if marker and marker in lowered:
            return str(rule.get("response", DEFAULT_REPLY))
    return DEFAULT_REPLY


def _extract_user_text(payload: dict[str, Any]) -> str:
    """Pull the last user-role message content out of an OpenAI-shaped
    chat-completions request body. Tolerates string and list-of-parts
    content shapes.
    """
    messages = payload.get("messages") or []
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    parts.append(part["text"])
            return "\n".join(parts)
        return str(content) if content is not None else ""
    return ""


app = FastAPI(title="mock-llm", version="0.1.0")


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Liveness probe. Confirms the service is up and the fixtures
    file is readable.
    """
    return {
        "status": "ok",
        "fixtures_path": str(FIXTURES_PATH),
        "fixtures_loaded": len(_fixtures()),
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    """OpenAI-compatible chat-completions endpoint.

    Reads the user's last message and returns the matching fixture
    response wrapped in the OpenAI ``chat.completion`` envelope. The
    envelope shape is the subset Bifrost / SK / litellm all parse the
    same way -- ``choices[0].message.content`` + ``usage`` tokens.
    """
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}") from exc

    user_text = _extract_user_text(payload)
    response_text = _pick_response(user_text)
    model = str(payload.get("model") or "mock/mock-model")

    body: dict[str, Any] = {
        "id": f"chatcmpl-mock-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": response_text,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": max(1, len(user_text) // 4),
            "completion_tokens": max(1, len(response_text) // 4),
            "total_tokens": max(2, (len(user_text) + len(response_text)) // 4),
        },
    }
    return JSONResponse(body)


@app.get("/")
async def root() -> dict[str, Any]:
    """Convenience landing page so a curl from a confused dev gets a
    self-explanatory response instead of a 404.
    """
    return {
        "service": "mock-llm",
        "purpose": "Deterministic LLM responses for Bruno + e2e tests",
        "endpoints": ["/v1/chat/completions", "/healthz"],
        "fixtures_path": str(FIXTURES_PATH),
        "fixtures_loaded": len(_fixtures()),
    }
