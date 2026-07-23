"""LLM Gateway package — thin client layer for Bifrost proxy integration.

All LLM calls in the framework route through this package. Agent adapters MUST
use :class:`LLMGateway` rather than calling provider APIs directly.

Public API
----------

Core gateway::

    from agent_service_maf.gateway import LLMGateway, LLMCompletionResponse, GatewayToolResult

Usage tracking::

    from agent_service_maf.gateway import UsageTracker

HTTP client interface (DIP)::

    from agent_service_maf.gateway import HttpLLMClient, BifrostClient

Secret masking::

    from agent_service_maf.gateway import SecretRedactor

Tool execution strategy interface::

    from agent_service_maf.gateway import ToolExecutionStrategy
"""

from __future__ import annotations

from agent_service_maf.gateway.cost_tracker import UsageTracker
from agent_service_maf.gateway.http_llm_client import BifrostClient, HttpLLMClient
from agent_service_maf.gateway.llm_gateway import (
    GatewayToolResult,
    LLMCompletionResponse,
    LLMGateway,
)
from agent_service_maf.gateway.project_vk_resolver import (
    MissingProjectVirtualKeyError,
    ProjectVKResolver,
)
from agent_service_maf.gateway.secret_redactor import SecretRedactor
from agent_service_maf.gateway.tool_strategy import ToolExecutionStrategy

__all__ = [
    # Core gateway
    "LLMGateway",
    "LLMCompletionResponse",
    "GatewayToolResult",
    # Usage tracking
    "UsageTracker",
    # HTTP client interface + production implementation
    "HttpLLMClient",
    "BifrostClient",
    # Per-project virtual-key resolution
    "ProjectVKResolver",
    "MissingProjectVirtualKeyError",
    # Logging security
    "SecretRedactor",
    # Tool execution strategy interface
    "ToolExecutionStrategy",
]
