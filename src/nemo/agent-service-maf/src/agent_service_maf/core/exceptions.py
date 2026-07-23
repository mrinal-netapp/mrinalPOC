"""Exception hierarchy for the agent framework.

All framework-specific exceptions inherit from :class:`AgentFrameworkError`.
This makes it easy for callers to catch all framework errors with a single
``except AgentFrameworkError`` clause while still being able to handle
domain-specific errors individually.

Hierarchy:
    AgentFrameworkError
    ├── ConfigurationError
    ├── FrameworkNotFoundError
    ├── AgentInvocationError
    ├── AuthenticationError
    ├── ValidationError
    ├── StreamingError
    ├── MCPConnectionError
    ├── MCPToolError
    ├── GatewayError
    │   └── RateLimitError
    ├── SessionNotFoundError
    ├── A2ATaskError
    │   └── A2ATaskNotFoundError
    ├── MCPServerError
    ├── ProtocolError
    └── GuardrailError
        ├── InputBlockedError
        ├── OutputBlockedError
        └── ToolUnauthorizedError
"""

from __future__ import annotations

from typing import Any


class AgentFrameworkError(Exception):
    """Base exception for all agent framework errors.

    All domain-specific exceptions inherit from this class. Callers can catch
    this base class to handle any framework error, or catch a specific subclass
    for targeted handling.

    Attributes:
        details: A dict of machine-readable debugging information. Never logged
            to external systems directly — pass through
            :class:`~agent_service_maf.interface_layer.error_formatter.SafeErrorFormatter`
            first to scrub sensitive data.

    Args:
        message: Human-readable error description. Should explain what went wrong
            AND how to fix it. See engineering-standards.md §4.3.
        details: Optional dict with debugging context (e.g., agent_id, framework,
            duration_ms). Defaults to empty dict.

    Example:
        >>> raise AgentFrameworkError(
        ...     "Config validation failed for field 'model'. "
        ...     "Check agent.model in agent_config.json or AGENT_AGENT__MODEL env var.",
        ...     details={"field": "model", "value": "bad-value"},
        ... )
    """

    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details: dict[str, Any] = details or {}


class ConfigurationError(AgentFrameworkError):
    """Raised when configuration is invalid, missing, or contains secrets.

    Common causes:
        - A required field is missing from both env vars and the JSON config.
        - A field value fails Pydantic validation (e.g., port out of range).
        - A secret (key, token, password) appears in a config file instead of an
          environment variable.
        - A locked field is overridden via ``config_overrides`` in a request.

    How to fix:
        - Check ``agent_config.json`` for the field name and correct the value.
        - For secrets, use the corresponding ``AGENT_*`` environment variable instead.
        - Consult ``configs/agent_config.reference.yaml`` for the full schema.
    """

    pass


class FrameworkNotFoundError(AgentFrameworkError):
    """Raised when a requested agent framework adapter is not registered.

    Common causes:
        - The framework name in ``agent.framework`` config does not match any
          registered adapter.
        - The adapter module was not imported (registration happens at import time).
        - A typo in the framework name.

    How to fix:
        - Check ``FrameworkRegistry.list_frameworks()`` for available names.
        - Ensure the adapter module is imported in ``framework/__init__.py``.
        - Verify the ``@FrameworkRegistry.register("name")`` decorator is present.

    Example:
        >>> raise FrameworkNotFoundError(
        ...     "Framework 'unknown' is not registered. "
        ...     "Available: ['maf', 'echo']. "
        ...     "Ensure the adapter is imported in framework/__init__.py.",
        ...     details={"requested": "unknown", "available": ["maf", "echo"]},
        ... )
    """

    pass


class AgentInvocationError(AgentFrameworkError):
    """Raised when an agent fails during invocation or streaming.

    Wraps any adapter-level exception so callers have a single type to catch
    for execution failures. The original exception is chained via ``__cause__``.

    Common causes:
        - The underlying LLM call fails (timeout, rate limit, invalid request).
        - An MCP tool call throws an unhandled exception.
        - The agent's framework raises a framework-specific error.

    How to fix:
        - Inspect ``exc.__cause__`` for the original exception.
        - Check ``exc.details`` for ``agent_id``, ``framework``, and ``duration_ms``.
        - Review adapter logs for the full stack trace (available in dev mode).
    """

    pass


class AgentTimeoutError(AgentInvocationError):
    """Raised when an agent invocation exceeds ``agent.timeout_seconds``.

    Distinct from a generic invocation failure so the HTTP layer can return a
    specific timeout message instead of "An internal error occurred."

    ``details`` typically carries:
        - ``timeout_seconds``: the configured wall-clock cap that was hit.
        - ``orchestration_type``: which orchestration path timed out
          (``magentic``, ``sequential``, etc.).
    """

    pass


class AuthenticationError(AgentFrameworkError):
    """Raised when a request fails authentication or authorization.

    Common causes:
        - Missing or invalid ``X-API-Key`` header.
        - Expired or invalid OAuth2 Bearer token.
        - Client IP exceeds WebSocket connection limit.

    How to fix:
        - Provide a valid API key in the ``X-API-Key`` header.
        - For OAuth2, refresh the token and retry.
        - Check ``interface.auth`` config to verify the expected scheme.
    """

    pass


class ValidationError(AgentFrameworkError):
    """Raised when request input fails validation before reaching the adapter.

    Common causes:
        - Request body exceeds ``interface.request_validation.max_input_length``.
        - An unknown key is present in ``AgentRequest.context``.
        - A locked config field is included in ``config_overrides``.
        - An agent/tool/server name does not match ``^[a-zA-Z0-9_-]{1,64}$``.

    How to fix:
        - Review the validation error message for the specific field and constraint.
        - Consult the ``AgentRequest`` docstring for allowed ``context`` keys.
        - Remove locked fields (``agent.framework``, ``project_id``) from
          ``config_overrides``.
    """

    pass


class StreamingError(AgentFrameworkError):
    """Raised when a streaming session is terminated due to limit enforcement.

    Common causes:
        - The stream exceeded ``streaming.max_duration_seconds``.
        - The stream produced more than ``streaming.max_events`` events.
        - The connection was idle for longer than ``streaming.idle_timeout_seconds``.

    How to fix:
        - Adjust streaming limits in ``interface.streaming`` config section.
        - For long-running tasks, consider using the REST endpoint instead.
        - Ensure the client sends activity to reset the idle timeout.
    """

    pass


class MCPConnectionError(AgentFrameworkError):
    """Raised when connecting to or communicating with an MCP server fails.

    This covers transport-level failures (TCP, stdio pipe failures, WebSocket
    errors). For tool execution failures after a successful connection, use
    :class:`MCPToolError`.

    Common causes:
        - The MCP server is not running or unreachable.
        - The ``mcp_servers`` config in the agent config is missing or malformed.
        - Authentication to the MCP server failed.
        - Connection timeout exceeded ``mcp.connection_timeout_seconds``.

    How to fix:
        - Verify the MCP server is running: ``curl <server_url>/health``.
        - Check the ``mcp_servers`` array in the agent config for correct URLs and transport type.
        - Increase ``mcp.connection_timeout_seconds`` for slow networks.
    """

    pass


class MCPToolError(AgentFrameworkError):
    """Raised when an MCP tool call fails during execution.

    Distinct from :class:`MCPConnectionError` — the connection succeeded but the
    tool itself returned an error or raised an exception.

    Attributes:
        server_name: The MCP server that hosts the failing tool.
        tool_name: The name of the tool that failed.

    Args:
        message: Description of the tool failure.
        server_name: MCP server identifier (e.g., ``"vector-db"``).
        tool_name: Tool identifier (e.g., ``"semantic_search"``).
        details: Additional debugging context.

    Common causes:
        - Invalid tool arguments (schema mismatch).
        - The tool's backend service is unavailable.
        - Tool result exceeded ``mcp.max_result_size_bytes``.
        - Tool execution timed out.

    How to fix:
        - Verify tool arguments match the tool's JSON Schema.
        - Check the MCP server logs for the specific tool error.
        - Inspect ``exc.server_name`` and ``exc.tool_name`` to identify the failing tool.

    Example:
        >>> raise MCPToolError(
        ...     "Tool 'semantic_search' returned error: index not found. "
        ...     "Ensure the vector database is initialized before calling this tool.",
        ...     server_name="vector-db",
        ...     tool_name="semantic_search",
        ...     details={"error_code": "INDEX_NOT_FOUND"},
        ... )
    """

    def __init__(
        self,
        message: str,
        server_name: str = "",
        tool_name: str = "",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message, details)
        self.server_name = server_name
        self.tool_name = tool_name


class GatewayError(AgentFrameworkError):
    """Raised when the LLM gateway encounters an error.

    This covers HTTP errors from the Bifrost proxy, invalid model strings,
    and unexpected response formats. For rate limiting specifically, use
    :class:`RateLimitError`.

    Common causes:
        - The gateway URL is unreachable (``gateway.url``).
        - The model string is invalid or not available on the gateway.
        - The gateway returned an unexpected HTTP status code.
        - ``max_tool_rounds`` was exceeded in a tool-use loop.

    How to fix:
        - Check ``gateway.url`` is correct and Bifrost is running.
        - Verify the model name is valid for your Bifrost configuration.
        - Review the gateway logs for detailed error messages.
    """

    pass


class RateLimitError(GatewayError):
    """Raised when LLM gateway rate limits are exceeded.

    Inherits from :class:`GatewayError`. Callers that handle rate limiting
    differently (e.g., retry with backoff) should catch this subclass.

    Common causes:
        - Requests per minute (RPM) exceeded ``gateway.rate_limit_rpm``.
        - Tokens per minute (TPM) exceeded ``gateway.rate_limit_tpm``.
        - The upstream LLM provider's own rate limits were reached.

    How to fix:
        - Reduce request frequency or increase gateway rate limit config.
        - Implement exponential backoff with ``exc.details.get("retry_after_seconds")``.
        - Consider using fallback models via ``gateway.fallback_models``.
    """

    pass


# ---------------------------------------------------------------------------
# Session & Protocol Errors
# ---------------------------------------------------------------------------


class SessionNotFoundError(AgentFrameworkError):
    """Raised when a requested session does not exist or has expired.

    Common causes:
        - The session TTL expired (``session.ttl_seconds``).
        - An incorrect session ID was provided.
        - The server was restarted and in-memory sessions were lost.

    How to fix:
        - Start a new session by omitting ``session_id`` from the request.
        - Increase ``session.ttl_seconds`` for longer-lived sessions.
        - Implement client-side session recovery logic.
    """

    pass


class A2ATaskError(AgentFrameworkError):
    """Raised when an A2A (Agent-to-Agent) task operation fails.

    Common causes:
        - The A2A task timed out.
        - The remote agent returned an error response.
        - Push notification delivery failed.

    How to fix:
        - Check the A2A task status via the task ID.
        - Verify the remote agent is reachable at its advertised URL.
    """

    pass


class A2ATaskNotFoundError(A2ATaskError):
    """Raised when a referenced A2A task does not exist.

    Common causes:
        - The task ID is invalid or was never created.
        - The task expired and was removed from the store.

    How to fix:
        - Verify the task ID from the original A2A request.
        - Check if the task store TTL is too short for long-running tasks.
    """

    pass


class MCPServerError(AgentFrameworkError):
    """Raised when the framework's MCP server mode encounters an error.

    This is for errors in the *server* role (exposing agents as MCP tools),
    not the *client* role (calling external MCP tools).

    How to fix:
        - Check the MCP server transport config (``mcp_server.transport``).
        - Ensure only one process is running in MCP server mode.
    """

    pass


class ProtocolError(AgentFrameworkError):
    """Raised for protocol-level errors (invalid wire format, unexpected message type).

    Common causes:
        - A WebSocket message could not be parsed as a valid JSON request.
        - An A2A message contained an unrecognized task type.
        - An SSE stream was malformed.

    How to fix:
        - Validate the client-side message format against the API schema.
        - Check for version mismatches between client and server.
    """

    pass


# ---------------------------------------------------------------------------
# Guardrail Errors (Phase 3.5)
# ---------------------------------------------------------------------------


class GuardrailError(AgentFrameworkError):
    """Base exception for guardrail violations and internal guardrail failures.

    Raised when a guardrail blocks a request (via a subclass) or when a guardrail
    encounters an internal error (fail_open=False).

    Common causes:
        - A guardrail returned ``BLOCK`` action (see subclasses).
        - A guardrail implementation raised an unexpected exception and
          ``guardrails.fail_open`` is ``False``.

    How to fix:
        - For blocked requests: inspect the guardrail name and message in the
          error details to understand what triggered the block.
        - For internal errors: check logs for the correlation_id and review the
          guardrail implementation. Set ``guardrails.fail_open=true`` temporarily
          to allow requests through while debugging.

    Client responses MUST NOT include ``details`` — only ``guardrail_name`` and
    ``message``. See engineering-standards.md §1.3.
    """

    pass


class InputBlockedError(GuardrailError):
    """Raised when an input guardrail blocks a request before agent execution.

    HTTP mapping: 422 Unprocessable Entity.

    Common causes:
        - Input exceeds ``max_length`` or is empty.
        - Prompt injection patterns were detected.
        - PII masking guardrail encountered an error in block mode.

    How to fix:
        - Review the ``message`` field for which guardrail triggered and why.
        - Check ``guardrails.input_guardrails`` config for the rule.
        - If the block is a false positive, adjust the guardrail config or
          disable the specific rule for the relevant agent via ``agent_overrides``.

    Example:
        >>> raise InputBlockedError(
        ...     "Request blocked by guardrail 'prompt_injection': "
        ...     "Detected injection pattern in input.",
        ...     details={"guardrail_name": "prompt_injection", "correlation_id": "abc"},
        ... )
    """

    pass


class OutputBlockedError(GuardrailError):
    """Raised when an output guardrail blocks a response after agent execution.

    HTTP mapping: 500 Internal Server Error (agent produced unsafe output).

    Common causes:
        - Agent output contains a leaked API key or secret.
        - Output exceeds ``max_chars`` in output_length guardrail with
          ``action_on_trigger=block``.
        - Content filter detected unsafe content.

    How to fix:
        - Review the agent's system prompt and tool outputs for secret leakage.
        - Reduce ``max_tokens`` in agent config to prevent excessively long outputs.
        - Check if a tool result contains secrets being echoed back by the agent.

    Example:
        >>> raise OutputBlockedError(
        ...     "Request blocked by guardrail 'content_filter': "
        ...     "Detected potential API key in output.",
        ...     details={"guardrail_name": "content_filter", "correlation_id": "abc"},
        ... )
    """

    pass


class ToolUnauthorizedError(GuardrailError):
    """Raised when a tool guardrail blocks a tool call during agent execution.

    HTTP mapping: 403 Forbidden.

    Common causes:
        - The tool is not in the agent's allowlist (``mode=allowlist``).
        - The tool is in the agent's denylist (``mode=denylist``).
        - The agent has exceeded ``max_calls_per_request`` tool calls.
        - Tool parameters contain path traversal or shell injection patterns.

    How to fix:
        - Add the tool to the agent's ``tool_policy.tools`` list if using allowlist mode.
        - Remove the tool from the denylist if the call is legitimate.
        - Increase ``tool_policy.max_calls_per_request`` if the agent needs more calls.
        - Review tool parameters for dangerous patterns (``../``, ``;``, ``|``).

    Example:
        >>> raise ToolUnauthorizedError(
        ...     "Request blocked by guardrail 'tool_authorizer': "
        ...     "Tool 'delete_database' is not in the agent's allowlist.",
        ...     details={"guardrail_name": "tool_authorizer", "tool_name": "delete_database"},
        ... )
    """

    pass
