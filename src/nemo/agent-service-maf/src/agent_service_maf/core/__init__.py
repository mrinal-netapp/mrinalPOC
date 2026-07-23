"""Core interfaces, context, and exceptions for the agent framework.

This package provides the foundational types that all other packages depend on:
- :mod:`~agent_service_maf.core.interfaces`: Data models and abstract interfaces.
- :mod:`~agent_service_maf.core.context`: Execution context (DI container).
- :mod:`~agent_service_maf.core.exceptions`: Exception hierarchy.
"""

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import (
    A2ATaskError,
    A2ATaskNotFoundError,
    AgentFrameworkError,
    AgentInvocationError,
    AuthenticationError,
    ConfigurationError,
    FrameworkNotFoundError,
    GatewayError,
    MCPConnectionError,
    MCPServerError,
    MCPToolError,
    ProtocolError,
    RateLimitError,
    SessionNotFoundError,
    StreamingError,
    ValidationError,
)
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentCapabilityProvider,
    AgentEvent,
    AgentInterface,
    AgentInvoker,
    AgentLifecycle,
    AgentRequest,
    AgentResponse,
    EventType,
    EventTypeRegistry,
    TokenUsage,
)

__all__ = [
    # Interfaces
    "AgentInterface",
    "AgentInvoker",
    "AgentLifecycle",
    "AgentCapabilityProvider",
    # Data models
    "AgentRequest",
    "AgentResponse",
    "AgentEvent",
    "AgentCapabilities",
    "TokenUsage",
    "EventType",
    "EventTypeRegistry",
    # Context
    "AgentExecutionContext",
    # Exceptions
    "AgentFrameworkError",
    "ConfigurationError",
    "FrameworkNotFoundError",
    "AgentInvocationError",
    "AuthenticationError",
    "ValidationError",
    "StreamingError",
    "MCPConnectionError",
    "MCPToolError",
    "GatewayError",
    "RateLimitError",
    "SessionNotFoundError",
    "A2ATaskError",
    "A2ATaskNotFoundError",
    "MCPServerError",
    "ProtocolError",
]
