"""Echo adapter -- simple agent that echoes input back.

Used for E2E testing and as a reference implementation. Returns the
input text with a prefix. Supports both invoke and streaming.

Streaming emits the §5.4 wire vocabulary:
``started`` → ``thinking`` → ``token`` * N → ``completed`` (where the
``completed`` event carries ``metadata.invokeResponse`` populated by
:class:`~agent_service_maf.framework.response_builder.ResponseBuilder`).

Registered as ``"echo"`` in the framework registry at import time.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentCitationSource,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    Citations,
    EventType,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.framework.response_builder import (
    ResponseBuilder,
    extract_parsed_output,
)


def _resolve_request_output_schema(request: AgentRequest) -> dict[str, Any] | None:
    """Pick the per-request output schema off ``request.context``.

    Echo has no agent-level configuration, so only the per-request
    override is available. Mirrors the Option-B precedence the SK
    adapter applies but stops at step one.
    """
    ctx = request.context if request.context else {}
    schema = ctx.get("output_schema") or ctx.get("outputSchema")
    return schema if isinstance(schema, dict) else None


@FrameworkRegistry.register("echo")
class EchoAgent(BaseAgent):
    """Simple echo agent for testing and development.

    Returns the input text wrapped in a predictable format.
    Supports both synchronous invocation and streaming.

    Example:
        >>> agent = EchoAgent(config)
        >>> response = await agent.invoke(request, context)
        >>> response.output
        'Echo: Hello world'
    """

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        """Return the input text with an Echo prefix.

        Args:
            request: The agent invocation request.
            context: The execution context.

        Returns:
            AgentResponse with the echoed input.
        """
        words = request.input.split()
        output_text = f"Echo: {request.input}"
        parsed_output = extract_parsed_output(
            output_text,
            output_schema=_resolve_request_output_schema(request),
            expect_json=False,
            agent_id=request.agent_id,
            session_id=request.session_id,
        )
        return AgentResponse(
            agent_id=request.agent_id,
            output=output_text,
            parsed_output=parsed_output,
            usage=TokenUsage(
                prompt_tokens=len(words),
                completion_tokens=len(words),
                total_tokens=len(words) * 2,
                estimated_cost_usd=0.0,
            ),
            metadata={"framework": "echo"},
            citations=Citations(
                responding_agent=AgentCitationSource(
                    name=request.agent_id,
                    model="echo",
                    framework="echo",
                ),
            ),
            session_id=request.session_id,
        )

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        """Stream the echoed input as individual token events.

        Args:
            request: The agent invocation request.
            context: The execution context.

        Yields:
            ``started`` → ``thinking`` → ``token`` * N → ``completed``.
            The ``completed`` event carries
            ``metadata.invokeResponse`` per §5.4.4 so SSE consumers
            reassemble the same :class:`InvokeResponse` that REST sync
            returns for the same input.
        """
        builder = ResponseBuilder(
            agent_id=request.agent_id,
            session_id=request.session_id,
            framework="echo",
            output_schema=_resolve_request_output_schema(request),
        )
        builder.set_citations(
            Citations(
                responding_agent=AgentCitationSource(
                    name=request.agent_id,
                    model="echo",
                    framework="echo",
                ),
            )
        )

        yield AgentEvent(
            event_type=EventType.STARTED,
            metadata={"agentId": request.agent_id, "framework": "echo"},
        )
        yield AgentEvent(
            event_type=EventType.THINKING,
            data="Processing...",
            metadata={"agentId": request.agent_id},
        )

        # Emit the prefix + each token individually so the stream is
        # observably granular while the assembled output matches invoke().
        prefix = "Echo: "
        builder.add_token(prefix)
        yield AgentEvent(
            event_type=EventType.TOKEN,
            data=prefix,
            metadata={"agentId": request.agent_id},
        )
        words = request.input.split()
        for i, word in enumerate(words):
            chunk = word if i == 0 else f" {word}"
            builder.add_token(chunk)
            yield AgentEvent(
                event_type=EventType.TOKEN,
                data=chunk,
                metadata={"agentId": request.agent_id},
            )

        builder.set_usage(
            TokenUsage(
                prompt_tokens=len(words),
                completion_tokens=len(words),
                total_tokens=len(words) * 2,
                estimated_cost_usd=0.0,
            ).model_dump(by_alias=True)
        )

        yield AgentEvent(
            event_type=EventType.COMPLETED,
            metadata={
                "invokeResponse": builder.finalize().model_dump(by_alias=True),
            },
        )

    def get_capabilities(self) -> AgentCapabilities:
        """Return the echo adapter capabilities.

        Returns:
            AgentCapabilities describing this adapter.
        """
        return AgentCapabilities(
            agent_id="echo",
            framework="echo",
            supports_streaming=True,
            description="Echo agent for testing - returns input text",
        )
