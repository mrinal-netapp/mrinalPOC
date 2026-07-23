"""REST / SSE / WebSocket protocol adapter.

Thin translation layer: converts HTTP requests → AgentService calls → HTTP responses.
This replaces the original routes.py with a service-mediated version.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse

from agent_service_maf.config._override_applier import (
    config_overrides_to_agent_request_dict,
)
from agent_service_maf.core.exceptions import AgentFrameworkError, FrameworkNotFoundError
from agent_service_maf.core.interfaces import AgentEvent, EventType
from agent_service_maf.core.service import AgentService
from agent_service_maf.interface_layer.models import (
    AgentListResponse,
    HealthResponse,
    InvokeRequest,
    InvokeResponse,
)

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["REST"])


# ------------------------------------------------------------------
# Synchronous invocation
# ------------------------------------------------------------------


@router.post("/agents/{agent_id}/invoke", response_model=InvokeResponse)
async def invoke_agent(agent_id: str, body: InvokeRequest, request: Request) -> InvokeResponse:
    """Synchronous agent invocation — returns complete response."""
    try:
        service = _get_service(request)
        response = await service.invoke(
            agent_id=agent_id,
            input_text=body.input,
            context=body.context,
            config_overrides=config_overrides_to_agent_request_dict(body.config_overrides),
            session_id=body.session_id,
            metadata=body.metadata,
        )
        return InvokeResponse.from_agent_response(response)

    except FrameworkNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except AgentFrameworkError as e:
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------
# SSE streaming
# ------------------------------------------------------------------


@router.post("/agents/{agent_id}/stream")
async def stream_agent(agent_id: str, body: InvokeRequest, request: Request) -> EventSourceResponse:
    """SSE streaming agent invocation — streams events as they occur."""
    service = _get_service(request)

    async def _generate() -> AsyncIterator[dict[str, str]]:
        try:
            yield _format_sse(AgentEvent(event_type=EventType.STARTED))

            async for event in service.stream(
                agent_id=agent_id,
                input_text=body.input,
                context=body.context,
                config_overrides=config_overrides_to_agent_request_dict(body.config_overrides),
                session_id=body.session_id,
                metadata=body.metadata,
            ):
                yield _format_sse(event)

            yield _format_sse(AgentEvent(event_type=EventType.COMPLETED))

        except Exception as e:
            logger.error("SSE stream error", error=str(e))
            yield _format_sse(
                AgentEvent(
                    event_type=EventType.ERROR,
                    data=str(e),
                    metadata={"error_type": type(e).__name__},
                )
            )

    return EventSourceResponse(_generate())


# ------------------------------------------------------------------
# WebSocket bidirectional
# ------------------------------------------------------------------


@router.websocket("/agents/{agent_id}/ws")
async def websocket_agent(websocket: WebSocket, agent_id: str) -> None:
    """WebSocket bidirectional agent invocation."""
    await websocket.accept()
    service = _get_service(websocket.app)

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
                invoke_req = InvokeRequest(**data)
            except (json.JSONDecodeError, Exception) as e:
                await websocket.send_json({"event": "error", "data": f"Invalid request: {e}"})
                continue

            try:
                await websocket.send_json({"event": "started", "data": ""})

                async for event in service.stream(
                    agent_id=agent_id,
                    input_text=invoke_req.input,
                    context=invoke_req.context,
                    config_overrides=config_overrides_to_agent_request_dict(
                        invoke_req.config_overrides
                    ),
                    session_id=invoke_req.session_id,
                    metadata=invoke_req.metadata,
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
                logger.error("WebSocket agent error", error=str(e), agent_id=agent_id)
                await websocket.send_json(
                    {
                        "event": EventType.ERROR.value,
                        "data": str(e),
                        "metadata": {"error_type": type(e).__name__},
                    }
                )

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected", agent_id=agent_id)


# ------------------------------------------------------------------
# Discovery & health
# ------------------------------------------------------------------


@router.get("/agents", response_model=AgentListResponse)
async def list_agents(request: Request) -> AgentListResponse:
    """List all registered agent frameworks."""
    service = _get_service(request)
    agents = service.list_agents()
    return AgentListResponse(agents=agents, total=len(agents))


@router.get("/agents/{agent_id}/capabilities")
async def get_capabilities(agent_id: str, request: Request) -> dict:
    """Get capabilities of a specific agent."""
    try:
        service = _get_service(request)
        return service.get_agent_capabilities(agent_id).model_dump()
    except FrameworkNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/health", response_model=HealthResponse)
async def health_check(request: Request) -> HealthResponse:
    """Health check endpoint."""
    uptime = time.time() - getattr(request.app.state, "start_time", time.time())
    return HealthResponse(
        status="healthy",
        version="0.1.0",
        uptime_seconds=round(uptime, 2),
    )


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


def _get_service(app_or_request: Any) -> AgentService:
    """Extract AgentService from app state (works with Request or app object)."""
    if hasattr(app_or_request, "app"):
        return app_or_request.app.state.agent_service
    return app_or_request.state.agent_service
