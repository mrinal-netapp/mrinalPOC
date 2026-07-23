"""Configuration management with 3-tier merge: env vars -> JSON file -> request.

Public API exported from this package:

- :class:`ConfigLoader` — loads, merges, and validates configuration.
- :func:`deep_merge` — recursive dict merge utility.
- :data:`DEFAULTS` — baseline configuration dict.
- Pydantic model classes for every config section.

Quick start:

    >>> from agent_service_maf.config import ConfigLoader
    >>> loader = ConfigLoader("configs/agent_config.json")
    >>> config = loader.resolve()
    >>> config.agent.model
    'anthropic/claude-sonnet-4-20250514'

Per-request override (non-locked fields only):

    >>> config = loader.resolve({"agent": {"temperature": 0.2, "max_tokens": 8192}})
"""

from __future__ import annotations

from agent_service_maf.config.config_loader import ConfigLoader, deep_merge
from agent_service_maf.config.defaults import DEFAULTS
from agent_service_maf.config.file_loader import FileConfigLoader
from agent_service_maf.config.remote_adapter import (
    adapt_remote_to_maf_config,
    agent_record_to_sk_agent,
    knowledge_base_record_to_function_binding,
    mcp_server_record_to_inline_config,
    synthetic_single_agent_team,
    team_blob_to_maf_payload,
)
from agent_service_maf.config.remote_loader import RemoteConfigCache
from agent_service_maf.config.service_auth import ServiceAccountClient
from agent_service_maf.config.settings import ConfigSource, Settings, settings
from agent_service_maf.config.validators import (
    AgentConfig,
    AgentGuardrailConfig,
    AgentSection,
    AuthSection,
    GatewaySection,
    GuardrailRule,
    GuardrailSection,
    InterfaceSection,
    LoggingSection,
    MCPSection,
    StreamingSection,
    ToolPolicy,
)

__all__ = [
    # 3-tier loader
    "ConfigLoader",
    "deep_merge",
    "DEFAULTS",
    # Validators (Pydantic models)
    "AgentConfig",
    "AgentGuardrailConfig",
    "AgentSection",
    "AuthSection",
    "GatewaySection",
    "GuardrailRule",
    "GuardrailSection",
    "InterfaceSection",
    "LoggingSection",
    "MCPSection",
    "StreamingSection",
    "ToolPolicy",
    # Config-service migration surface
    "ConfigSource",
    "Settings",
    "settings",
    "ServiceAccountClient",
    "RemoteConfigCache",
    "FileConfigLoader",
    "adapt_remote_to_maf_config",
    "agent_record_to_sk_agent",
    "knowledge_base_record_to_function_binding",
    "mcp_server_record_to_inline_config",
    "team_blob_to_maf_payload",
    "synthetic_single_agent_team",
]
