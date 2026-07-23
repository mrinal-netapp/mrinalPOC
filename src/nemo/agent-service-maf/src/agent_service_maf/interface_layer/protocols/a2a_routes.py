"""Google Agent-to-Agent (A2A) protocol adapter.

Implements the A2A HTTP endpoints per the Google specification:
  - GET  /.well-known/agent.json       → Agent Card
  - POST /a2a                          → JSON-RPC 2.0 dispatcher
    - tasks/send                       → Synchronous task execution
    - tasks/sendSubscribe              → SSE-streamed task execution
    - tasks/get                        → Get task status
    - tasks/cancel                     → Cancel running task

All A2A methods use JSON-RPC 2.0 wire format.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from agent_service_maf.core.exceptions import A2ATaskNotFoundError
from agent_service_maf.core.service import AgentService
from agent_service_maf.interface_layer.protocols.a2a_models import (
    A2A_TASK_NOT_FOUND,
    JSONRPC_INTERNAL_ERROR,
    JSONRPC_INVALID_PARAMS,
    JSONRPC_METHOD_NOT_FOUND,
    A2AAgentCapabilities,
    A2AAgentCard,
    A2AAgentSkill,
    JSONRPCError,
    JSONRPCRequest,
    JSONRPCResponse,
    TaskCancelParams,
    TaskQueryParams,
    TaskSendParams,
)
from agent_service_maf.interface_layer.protocols.a2a_task_manager import A2ATaskManager

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["A2A"])


# ------------------------------------------------------------------
# Agent Card
# ------------------------------------------------------------------


@router.get("/.well-known/agent.json")
async def get_agent_card(request: Request) -> dict:
    """Publish the Agent Card per A2A spec.

    This is how other agents discover this service's capabilities.
    """
    service: AgentService = request.app.state.agent_service
    a2a_config = request.app.state.config.a2a

    # Build skills from registered frameworks
    frameworks = service.framework_registry.list_frameworks()
    skills = [
        A2AAgentSkill(
            id=f"invoke-{fw}",
            name=f"Invoke {fw} agent",
            description=f"Execute a task using the {fw} agent framework",
            tags=[fw, "agent", "ai"],
            examples=[f"Use {fw} to analyze this data", f"Ask the {fw} agent to help"],
        )
        for fw in frameworks
    ]

    card = A2AAgentCard(
        name=a2a_config.agent_name,
        description=a2a_config.agent_description,
        url=a2a_config.agent_url,
        version=a2a_config.agent_version,
        capabilities=A2AAgentCapabilities(
            streaming=True,
            pushNotifications=a2a_config.supports_push_notifications,
        ),
        skills=skills,
    )

    return card.model_dump(exclude_none=True)


# ------------------------------------------------------------------
# JSON-RPC 2.0 Dispatcher
# ------------------------------------------------------------------


@router.post("/a2a")
async def a2a_dispatch(request: Request) -> JSONResponse | EventSourceResponse:
    """JSON-RPC 2.0 dispatcher for A2A methods.

    Routes to the appropriate handler based on the method field.
    """
    try:
        body = await request.json()
        rpc_request = JSONRPCRequest(**body)
    except Exception as e:
        return JSONResponse(
            content=JSONRPCResponse(
                id=0,
                error=JSONRPCError(
                    code=JSONRPC_INVALID_PARAMS,
                    message=f"Invalid JSON-RPC request: {e}",
                ),
            ).model_dump(exclude_none=True),
            status_code=400,
        )

    task_manager: A2ATaskManager = request.app.state.a2a_task_manager

    # Route to handler
    handlers = {
        "tasks/send": _handle_tasks_send,
        "tasks/sendSubscribe": _handle_tasks_send_subscribe,
        "tasks/get": _handle_tasks_get,
        "tasks/cancel": _handle_tasks_cancel,
    }

    handler = handlers.get(rpc_request.method)
    if handler is None:
        return JSONResponse(
            content=JSONRPCResponse(
                id=rpc_request.id,
                error=JSONRPCError(
                    code=JSONRPC_METHOD_NOT_FOUND,
                    message=f"Unknown method: {rpc_request.method}",
                ),
            ).model_dump(exclude_none=True),
            status_code=404,
        )

    return await handler(rpc_request, task_manager)


# ------------------------------------------------------------------
# Method Handlers
# ------------------------------------------------------------------


async def _handle_tasks_send(
    rpc_request: JSONRPCRequest,
    task_manager: A2ATaskManager,
) -> JSONResponse:
    """Handle tasks/send — synchronous task execution."""
    try:
        params = TaskSendParams(**rpc_request.params)
        task = await task_manager.send(params)

        return JSONResponse(
            content=JSONRPCResponse(
                id=rpc_request.id,
                result=task.model_dump(exclude_none=True),
            ).model_dump(exclude_none=True)
        )

    except Exception as e:
        return _error_response(rpc_request.id, JSONRPC_INTERNAL_ERROR, str(e))


async def _handle_tasks_send_subscribe(
    rpc_request: JSONRPCRequest,
    task_manager: A2ATaskManager,
) -> EventSourceResponse:
    """Handle tasks/sendSubscribe — SSE-streamed task execution."""
    try:
        params = TaskSendParams(**rpc_request.params)
    except Exception as e:
        # Return error as SSE event since we need to return EventSourceResponse
        err_message = str(e)

        async def _error_gen() -> AsyncIterator[dict[str, str]]:
            yield {
                "event": "error",
                "data": json.dumps(
                    JSONRPCResponse(
                        id=rpc_request.id,
                        error=JSONRPCError(
                            code=JSONRPC_INVALID_PARAMS,
                            message=err_message,
                        ),
                    ).model_dump(exclude_none=True)
                ),
            }

        return EventSourceResponse(_error_gen())

    async def _stream_gen() -> AsyncIterator[dict[str, str]]:
        try:
            async for task_snapshot in task_manager.send_subscribe(params):
                yield {
                    "event": "task_status",
                    "data": json.dumps(
                        JSONRPCResponse(
                            id=rpc_request.id,
                            result=task_snapshot.model_dump(exclude_none=True),
                        ).model_dump(exclude_none=True)
                    ),
                }
        except Exception as exc:
            yield {
                "event": "error",
                "data": json.dumps(
                    JSONRPCResponse(
                        id=rpc_request.id,
                        error=JSONRPCError(
                            code=JSONRPC_INTERNAL_ERROR,
                            message=str(exc),
                        ),
                    ).model_dump(exclude_none=True)
                ),
            }

    return EventSourceResponse(_stream_gen())


async def _handle_tasks_get(
    rpc_request: JSONRPCRequest,
    task_manager: A2ATaskManager,
) -> JSONResponse:
    """Handle tasks/get — retrieve task status."""
    try:
        params = TaskQueryParams(**rpc_request.params)
        task = await task_manager.get_task(
            task_id=params.id,
            history_length=params.historyLength,
        )

        return JSONResponse(
            content=JSONRPCResponse(
                id=rpc_request.id,
                result=task.model_dump(exclude_none=True),
            ).model_dump(exclude_none=True)
        )

    except A2ATaskNotFoundError:
        return _error_response(rpc_request.id, A2A_TASK_NOT_FOUND, f"Task '{params.id}' not found")
    except Exception as e:
        return _error_response(rpc_request.id, JSONRPC_INTERNAL_ERROR, str(e))


async def _handle_tasks_cancel(
    rpc_request: JSONRPCRequest,
    task_manager: A2ATaskManager,
) -> JSONResponse:
    """Handle tasks/cancel — cancel a running task."""
    try:
        params = TaskCancelParams(**rpc_request.params)
        task = await task_manager.cancel_task(params)

        return JSONResponse(
            content=JSONRPCResponse(
                id=rpc_request.id,
                result=task.model_dump(exclude_none=True),
            ).model_dump(exclude_none=True)
        )

    except A2ATaskNotFoundError:
        return _error_response(rpc_request.id, A2A_TASK_NOT_FOUND, f"Task '{params.id}' not found")
    except Exception as e:
        return _error_response(rpc_request.id, JSONRPC_INTERNAL_ERROR, str(e))


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _error_response(request_id: str | int, code: int, message: str) -> JSONResponse:
    """Build a JSON-RPC error response."""
    return JSONResponse(
        content=JSONRPCResponse(
            id=request_id,
            error=JSONRPCError(code=code, message=message),
        ).model_dump(exclude_none=True),
        status_code=200,  # JSON-RPC errors are still 200 OK at HTTP level
    )
