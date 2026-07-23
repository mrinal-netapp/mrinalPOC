"""AgentService — the single mediator between all protocol adapters and the agent framework.

Every protocol (REST, Chat, MCP Server, A2A) calls AgentService.
AgentService handles session memory, context building, and delegates to AgentExecutor.
No protocol adapter should directly touch FrameworkRegistry or AgentExecutor.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any

import structlog

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import SessionNotFoundError
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
)
from agent_service_maf.core.session import ConversationMessage, SessionManager
from agent_service_maf.framework.executor import AgentExecutor
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.gateway.llm_gateway import LLMGateway
from agent_service_maf.mcp.mcp_registry import MCPRegistry

logger = structlog.get_logger(__name__)


class AgentService:
    """Central mediator for all agent invocations.

    This is the ONLY entry point that protocol adapters should use.
    It manages session memory, builds execution contexts, and delegates
    to the framework executor.
    """

    def __init__(
        self,
        config_loader: ConfigLoader,
        gateway: LLMGateway,
        mcp_registry: MCPRegistry,
        framework_registry: type[FrameworkRegistry] = FrameworkRegistry,
        session_manager: SessionManager | None = None,
    ) -> None:
        self._config_loader = config_loader
        self._gateway = gateway
        self._mcp_registry = mcp_registry
        self._framework_registry = framework_registry
        self._executor = AgentExecutor(registry=framework_registry)

        config = config_loader.resolve()
        self._session_manager = session_manager or SessionManager(
            ttl_seconds=config.memory.ttl_seconds,
            max_history_length=config.memory.max_history_length,
            max_tokens_per_session=config.memory.max_tokens_per_session,
        )

    @property
    def session_manager(self) -> SessionManager:
        """Expose session manager for protocol adapters that need direct access."""
        return self._session_manager

    @property
    def framework_registry(self) -> type[FrameworkRegistry]:
        """Expose registry for capability queries."""
        return self._framework_registry

    async def start(self) -> None:
        """Start background services (session cleanup, etc.)."""
        await self._session_manager.start()
        logger.info("AgentService started")

    async def stop(self) -> None:
        """Gracefully shut down."""
        await self._session_manager.stop()
        logger.info("AgentService stopped")

    # ------------------------------------------------------------------
    # Core invocation methods (used by ALL protocol adapters)
    # ------------------------------------------------------------------

    async def invoke(
        self,
        agent_id: str,
        input_text: str,
        *,
        context: dict[str, Any] | None = None,
        config_overrides: dict[str, Any] | None = None,
        session_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AgentResponse:
        """Synchronous agent invocation with optional session memory.

        This is the primary entry point for REST, A2A send, and MCP tool calls.
        """
        context = context or {}
        config_overrides = config_overrides or {}
        metadata = metadata or {}
        correlation_id = str(uuid.uuid4())

        # Inject conversation history if session exists
        if session_id:
            history = await self._session_manager.get_history(session_id)
            if history:
                context["conversation_history"] = [
                    {"role": m.role, "content": m.content} for m in history
                ]
            # Record user message
            await self._session_manager.append_message(
                session_id,
                ConversationMessage(role="user", content=input_text),
            )

        # Build execution context
        exec_context = self._build_context(
            config_overrides=config_overrides,
            metadata=metadata,
            session_id=session_id,
            correlation_id=correlation_id,
        )

        # Build internal request
        agent_request = AgentRequest(
            agent_id=agent_id,
            input=input_text,
            context=context,
            config_overrides=config_overrides,
            session_id=session_id,
            metadata=metadata,
        )

        # Delegate to executor
        response = await self._executor.invoke(agent_request, exec_context)

        # Record assistant response in session
        if session_id:
            await self._session_manager.append_message(
                session_id,
                ConversationMessage(
                    role="assistant",
                    content=response.output,
                    metadata={"agent_id": agent_id, "duration_ms": response.duration_ms},
                ),
            )

        return response

    async def stream(
        self,
        agent_id: str,
        input_text: str,
        *,
        context: dict[str, Any] | None = None,
        config_overrides: dict[str, Any] | None = None,
        session_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Streaming agent invocation with optional session memory.

        Yields AgentEvent objects. Used by SSE, WebSocket, and A2A sendSubscribe.
        """
        context = context or {}
        config_overrides = config_overrides or {}
        metadata = metadata or {}
        correlation_id = str(uuid.uuid4())

        # Inject conversation history
        if session_id:
            history = await self._session_manager.get_history(session_id)
            if history:
                context["conversation_history"] = [
                    {"role": m.role, "content": m.content} for m in history
                ]
            await self._session_manager.append_message(
                session_id,
                ConversationMessage(role="user", content=input_text),
            )

        exec_context = self._build_context(
            config_overrides=config_overrides,
            metadata=metadata,
            session_id=session_id,
            correlation_id=correlation_id,
        )

        agent_request = AgentRequest(
            agent_id=agent_id,
            input=input_text,
            context=context,
            config_overrides=config_overrides,
            session_id=session_id,
            metadata=metadata,
        )

        # Collect output for session recording
        collected_output: list[str] = []

        async for event in self._executor.stream(agent_request, exec_context):
            if event.event_type == EventType.TOKEN:
                collected_output.append(event.data)
            yield event

        # Record assistant response
        if session_id and collected_output:
            await self._session_manager.append_message(
                session_id,
                ConversationMessage(
                    role="assistant",
                    content="".join(collected_output),
                    metadata={"agent_id": agent_id, "streamed": True},
                ),
            )

    # ------------------------------------------------------------------
    # Capability queries
    # ------------------------------------------------------------------

    def list_agents(self) -> list[AgentCapabilities]:
        """List all registered agent frameworks with capabilities."""
        return self._framework_registry.list_capabilities()

    def get_agent_capabilities(self, agent_id: str) -> AgentCapabilities:
        """Get capabilities for a specific agent framework."""
        config = self._config_loader.resolve()
        agent = self._framework_registry.create(agent_id, config)
        return agent.get_capabilities()

    # ------------------------------------------------------------------
    # Session management (exposed for chat protocol)
    # ------------------------------------------------------------------

    async def get_session_history(self, session_id: str) -> list[ConversationMessage]:
        """Get conversation history for a session."""
        history = await self._session_manager.get_history(session_id)
        if not history:
            # Check if session exists at all
            session = await self._session_manager.get(session_id)
            if session is None:
                raise SessionNotFoundError(f"Session '{session_id}' not found or expired")
        return history

    async def clear_session(self, session_id: str) -> bool:
        """Clear a session's conversation history."""
        return await self._session_manager.clear_session(session_id)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_context(
        self,
        *,
        config_overrides: dict[str, Any],
        metadata: dict[str, Any],
        session_id: str | None,
        correlation_id: str,
    ) -> AgentExecutionContext:
        """Build an AgentExecutionContext from config + request overrides."""
        config = self._config_loader.resolve(request_overrides=config_overrides)
        return AgentExecutionContext(
            config=config,
            gateway=self._gateway,
            mcp_registry=self._mcp_registry,
            request_metadata=metadata,
            session_id=session_id,
            correlation_id=correlation_id,
        )
