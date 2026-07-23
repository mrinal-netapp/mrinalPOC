"""Chat protocol adapter — session-aware conversational endpoints.

Provides a chat-style interface with automatic server-side conversation memory.
Each session_id maintains its own message history that is injected into agent context.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import structlog
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse

from agent_service_maf.core.exceptions import (
    AgentFrameworkError,
    FrameworkNotFoundError,
    SessionNotFoundError,
)
from agent_service_maf.core.interfaces import AgentEvent, EventType
from agent_service_maf.core.service import AgentService
from agent_service_maf.interface_layer.models import (
    ChatHistoryResponse,
    ChatMessageModel,
    ChatRequest,
    ChatResponse,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/chat", tags=["Chat"])


def _get_service(request: Request) -> AgentService:
    return request.app.state.agent_service


# ------------------------------------------------------------------
# Synchronous chat message
# ------------------------------------------------------------------


@router.post("/{agent_id}/message", response_model=ChatResponse)
async def send_message(agent_id: str, body: ChatRequest, request: Request) -> ChatResponse:
    """Send a chat message — automatically manages conversation history.

    The service injects prior conversation history from this session_id
    into the agent's context, then records both the user message and
    assistant response.
    """
    try:
        service = _get_service(request)
        response = await service.invoke(
            agent_id=agent_id,
            input_text=body.input,
            config_overrides=body.config_overrides,
            session_id=body.session_id,
            metadata=body.metadata,
        )
        # When the caller didn't pin a session id, echo whatever the
        # service ended up using (matches the InvokeResponse contract
        # for session_id — always populated even when the client
        # didn't send one).
        return ChatResponse.from_agent_response(
            response,
            session_id=body.session_id or response.session_id or "",
        )

    except FrameworkNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except AgentFrameworkError as e:
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------
# Streaming chat message (SSE)
# ------------------------------------------------------------------


@router.post("/{agent_id}/message/stream")
async def stream_message(agent_id: str, body: ChatRequest, request: Request) -> EventSourceResponse:
    """Send a chat message with SSE streaming response.

    Conversation history is injected automatically. Streamed tokens are
    collected and recorded in session upon completion.
    """
    service = _get_service(request)

    async def _generate() -> AsyncIterator[dict[str, str]]:
        try:
            yield _format_sse(AgentEvent(event_type=EventType.STARTED))

            async for event in service.stream(
                agent_id=agent_id,
                input_text=body.input,
                config_overrides=body.config_overrides,
                session_id=body.session_id,
                metadata=body.metadata,
            ):
                yield _format_sse(event)

            yield _format_sse(AgentEvent(event_type=EventType.COMPLETED))

        except Exception as e:
            logger.error("Chat SSE stream error", error=str(e))
            yield _format_sse(
                AgentEvent(
                    event_type=EventType.ERROR,
                    data=str(e),
                    metadata={"error_type": type(e).__name__},
                )
            )

    return EventSourceResponse(_generate())


# ------------------------------------------------------------------
# WebSocket chat
# ------------------------------------------------------------------


@router.websocket("/{agent_id}/ws")
async def websocket_chat(websocket: WebSocket, agent_id: str) -> None:
    """WebSocket chat — bidirectional with automatic session tracking.

    Client sends: ``{"input": "...", "sessionId": "..."}`` (camelCase per
    §5.2; the legacy ``message`` field is no longer accepted -- see
    :class:`ChatRequest` docstring for the migration rationale).
    ``sessionId`` is optional; when omitted, the server runs the turn
    without history.

    Server streams: AgentEvent objects as JSON. Session memory is
    maintained across all messages that reuse the same ``sessionId``.
    """
    await websocket.accept()
    service: AgentService = websocket.app.state.agent_service

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
                chat_req = ChatRequest(**data)
            except (json.JSONDecodeError, Exception) as e:
                await websocket.send_json({"event": "error", "data": f"Invalid request: {e}"})
                continue

            try:
                await websocket.send_json({"event": "started", "data": ""})

                async for event in service.stream(
                    agent_id=agent_id,
                    input_text=chat_req.input,
                    config_overrides=chat_req.config_overrides,
                    session_id=chat_req.session_id,
                    metadata=chat_req.metadata,
                ):
                    await websocket.send_json(
                        {
                            "event": event.event_type.value,
                            "data": event.data,
                            "metadata": event.metadata,
                            "timestamp": event.timestamp.isoformat(),
                        }
                    )

                await websocket.send_json({"event": "completed", "data": ""})

            except Exception as e:
                logger.error("Chat WS error", error=str(e), agent_id=agent_id)
                await websocket.send_json(
                    {
                        "event": EventType.ERROR.value,
                        "data": str(e),
                        "metadata": {"error_type": type(e).__name__},
                    }
                )

    except WebSocketDisconnect:
        logger.info("Chat WebSocket disconnected", agent_id=agent_id)


# ------------------------------------------------------------------
# Session management
# ------------------------------------------------------------------


@router.get("/{agent_id}/history", response_model=ChatHistoryResponse)
async def get_history(
    agent_id: str, request: Request, session_id: str | None = None
) -> ChatHistoryResponse:
    """Retrieve conversation history for a session."""
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id query parameter is required")

    try:
        service = _get_service(request)
        history = await service.get_session_history(session_id)
        messages = [
            ChatMessageModel(
                role=m.role,
                content=m.content,
                timestamp=m.timestamp,
                metadata=(
                    m.metadata.model_dump(by_alias=True)
                    if hasattr(m.metadata, "model_dump")
                    else (m.metadata or {})
                ),
            )
            for m in history
        ]
        return ChatHistoryResponse(
            session_id=session_id,
            messages=messages,
            total=len(messages),
        )

    except SessionNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{agent_id}/history")
async def clear_history(agent_id: str, request: Request, session_id: str | None = None) -> dict:
    """Clear conversation history for a session."""
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id query parameter is required")

    service = _get_service(request)
    cleared = await service.clear_session(session_id)
    return {"cleared": cleared, "session_id": session_id}


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _format_sse(event: AgentEvent) -> dict[str, str]:
    """Format an AgentEvent as an SSE-compatible dict."""
    return {
        "event": event.event_type.value,
        "data": json.dumps(
            {
                "data": event.data,
                "metadata": event.metadata,
                "timestamp": event.timestamp.isoformat(),
            }
        ),
    }
