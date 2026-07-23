"""Mock LLM gateway server mimicking Bifrost/LiteLLM API.

Returns predictable chat completions for E2E testing.
Supports both synchronous and streaming responses.
Records request history for test assertions via GET /history.

Endpoints:
    POST /v1/chat/completions  -- OpenAI-compatible chat completion
    POST /chat/completions     -- Alias without /v1 prefix
    GET  /history              -- Return recorded request history
    DELETE /history            -- Clear request history
    GET  /health               -- Health check
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Mock LLM Server", version="0.1.0")

# In-memory request history for test assertions.
_request_history: list[dict[str, Any]] = []

# Fail-injection state — tests POST /admin/fail-next to set this so the
# next N chat-completion requests return the configured status. Lets e2e
# tests verify how the agent framework propagates upstream gateway
# failures (5xx → 502/503 envelope, 429 → backoff, mid-stream errors,
# WS error+close cleanup) without needing a real Bifrost outage.
_fail_state: dict[str, int] = {"remaining": 0, "status_code": 0}


def _build_completion_response(
    messages: list[dict[str, Any]],
    model: str,
    stream: bool,
) -> dict[str, Any]:
    """Build a predictable completion response based on the input messages.

    Args:
        messages: The chat messages from the request.
        model: The model string from the request.
        stream: Whether this is a streaming request.

    Returns:
        OpenAI-compatible chat completion response dict.
    """
    # Extract the last user message for the predictable response.
    user_message = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_message = msg.get("content", "")
            break

    # Build predictable response content.
    response_content = f"Mock LLM response to: {user_message}"

    # Check for tool call hints in the user message.
    tool_calls = None
    if "use tool" in user_message.lower() or "call tool" in user_message.lower():
        tool_calls = [
            {
                "id": f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name": "calculator",
                    "arguments": json.dumps({"expression": "2 + 2"}),
                },
            }
        ]
        response_content = ""

    completion_id = f"chatcmpl-mock-{uuid.uuid4().hex[:12]}"

    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": response_content,
                    "tool_calls": tool_calls,
                },
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": len(user_message.split()) * 2,
            "completion_tokens": len(response_content.split()) * 2,
            "total_tokens": (len(user_message.split()) + len(response_content.split())) * 2,
        },
    }


def _stream_chunks(
    messages: list[dict[str, Any]],
    model: str,
) -> list[dict[str, Any]]:
    """Build SSE stream chunks for a streaming completion.

    Args:
        messages: The chat messages from the request.
        model: The model string from the request.

    Returns:
        List of SSE chunk dicts.
    """
    user_message = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            user_message = msg.get("content", "")
            break

    response_content = f"Mock LLM response to: {user_message}"
    completion_id = f"chatcmpl-mock-{uuid.uuid4().hex[:12]}"
    tokens = response_content.split()

    chunks: list[dict[str, Any]] = []

    # First chunk with role.
    chunks.append(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": ""},
                    "finish_reason": None,
                }
            ],
        }
    )

    # Token chunks.
    for i, token in enumerate(tokens):
        prefix = " " if i > 0 else ""
        chunks.append(
            {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": prefix + token},
                        "finish_reason": None,
                    }
                ],
            }
        )

    # Final chunk with finish_reason.
    chunks.append(
        {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": len(user_message.split()) * 2,
                "completion_tokens": len(response_content.split()) * 2,
                "total_tokens": (len(user_message.split()) + len(response_content.split())) * 2,
            },
        }
    )

    return chunks


async def _handle_completions(request: Request) -> JSONResponse | StreamingResponse:
    """Handle a chat completion request (shared by /v1 and non-/v1 paths).

    Args:
        request: The incoming FastAPI request.

    Returns:
        JSON response for sync, StreamingResponse for stream=True.
    """
    body = await request.json()

    # Record the request.
    _request_history.append(
        {
            "timestamp": time.time(),
            "path": str(request.url.path),
            "body": body,
            "headers": dict(request.headers),
        }
    )

    # Fail-injection: when a test has scheduled the next N requests to
    # fail, return the configured upstream error envelope before doing
    # any normal work. Decrements the counter so a `fail-next 1` call
    # only affects exactly one request.
    if _fail_state["remaining"] > 0:
        _fail_state["remaining"] -= 1
        status = _fail_state["status_code"]
        error_body = {
            "error": {
                "message": f"injected upstream failure (status={status})",
                "type": "mock_injected_failure",
                "code": status,
            }
        }
        # 429 commonly carries Retry-After; emit it so the framework
        # can exercise its retry-after handling if wired.
        headers = {"Retry-After": "1"} if status == 429 else None
        return JSONResponse(status_code=status, content=error_body, headers=headers)

    messages = body.get("messages", [])
    model = body.get("model", "mock-model")
    stream = body.get("stream", False)

    if stream:
        chunks = _stream_chunks(messages, model)

        async def generate_stream() -> Any:  # noqa: ANN401
            for chunk in chunks:
                yield f"data: {json.dumps(chunk)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            generate_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    response = _build_completion_response(messages, model, stream=False)
    return JSONResponse(content=response)


@app.post("/v1/chat/completions", response_model=None)
async def chat_completions_v1(request: Request) -> JSONResponse | StreamingResponse:
    """OpenAI-compatible chat completion endpoint (v1 prefix).

    Args:
        request: The incoming request with chat completion payload.

    Returns:
        Chat completion response (sync or streaming).
    """
    return await _handle_completions(request)


@app.post("/chat/completions", response_model=None)
async def chat_completions(request: Request) -> JSONResponse | StreamingResponse:
    """Chat completion endpoint (no version prefix).

    Args:
        request: The incoming request with chat completion payload.

    Returns:
        Chat completion response (sync or streaming).
    """
    return await _handle_completions(request)


@app.post("/admin/fail-next")
async def fail_next(request: Request) -> JSONResponse:
    """Schedule the next N chat-completion requests to fail.

    Body: ``{"count": <int>, "status_code": <int>}``.

    Lets e2e tests inject upstream gateway failures without needing
    a real Bifrost outage. Counter decrements per failed request; a
    `count=1` call only affects the next single request. POST with
    `count=0` clears any pending failure.
    """
    body = await request.json()
    count = int(body.get("count", 0))
    status_code = int(body.get("status_code", 500))
    if status_code < 400 or status_code > 599:
        return JSONResponse(
            status_code=400,
            content={"error": "status_code must be a 4xx or 5xx value"},
        )
    _fail_state["remaining"] = max(0, count)
    _fail_state["status_code"] = status_code
    return JSONResponse(content={"scheduled_failures": count, "status_code": status_code})


@app.get("/history")
async def get_history() -> JSONResponse:
    """Return recorded request history for test assertions.

    Returns:
        JSON array of recorded request dicts.
    """
    return JSONResponse(content={"requests": _request_history, "total": len(_request_history)})


@app.delete("/history")
async def clear_history() -> JSONResponse:
    """Clear recorded request history.

    Returns:
        Confirmation message.
    """
    _request_history.clear()
    return JSONResponse(content={"status": "cleared"})


@app.get("/health")
async def health_check() -> JSONResponse:
    """Health check endpoint.

    Returns:
        Health status.
    """
    return JSONResponse(content={"status": "healthy", "service": "mock-llm"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=4000, log_level="info")
