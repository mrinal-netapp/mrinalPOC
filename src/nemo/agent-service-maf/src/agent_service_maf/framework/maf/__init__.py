"""Microsoft Agent Framework (AF) adapter package.

This subpackage holds the production adapter that runs agents on **Microsoft
Agent Framework** (upstream import root ``agent_framework``). It is named
``maf`` — not ``agent_framework`` — so it is never visually confused with the
upstream top-level package it imports.

Modules:
    - ``gateway_chat_client``: a custom AF chat client (composing AF's standard
      middleware / function-invocation / telemetry layers) that routes all LLM
      calls through the existing in-repo :class:`LLMGateway` (Bifrost proxy), so
      AF agents never talk to provider APIs directly. The function-invocation
      layer drives automatic tool calling.
    - ``adapter``: the ``BaseAgent`` implementation registered as ``"maf"``.
    - ``agent_builder``: builds AF agents from the ``semantic_kernel`` config.
    - ``event_mapper``: maps AF results + tool history to the frozen wire contract.
    - ``tools``: builds AF function/MCP tools (with citation-recording wrappers).
    - ``orchestration_builder``: maps config orchestration types to AF workflows
      (sequential, concurrent, handoff, triage, group_chat, magentic, graph).
"""

from __future__ import annotations

from agent_service_maf.framework.maf.adapter import AgentFrameworkAdapter
from agent_service_maf.framework.maf.agent_builder import BuiltMafAgent, MafAgentBuilder
from agent_service_maf.framework.maf.event_mapper import MafEventMapper
from agent_service_maf.framework.maf.gateway_chat_client import BifrostChatClient
from agent_service_maf.framework.maf.orchestration_builder import (
    SUPPORTED_ORCHESTRATION_TYPES,
    MafOrchestrationBuilder,
)
from agent_service_maf.framework.maf.tools import MafToolset, build_toolset

__all__ = [
    "SUPPORTED_ORCHESTRATION_TYPES",
    "AgentFrameworkAdapter",
    "BifrostChatClient",
    "BuiltMafAgent",
    "MafAgentBuilder",
    "MafEventMapper",
    "MafOrchestrationBuilder",
    "MafToolset",
    "build_toolset",
]
