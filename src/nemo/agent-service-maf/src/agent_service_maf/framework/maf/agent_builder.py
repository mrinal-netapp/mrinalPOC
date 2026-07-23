"""Agent builder -- constructs Microsoft Agent Framework agents from config.

It reads the framework-agnostic ``semantic_kernel`` config section (key name
retained for back-compat; agent definitions + per-agent model knobs) and
produces :class:`BuiltMafAgent` wrappers, each holding
a ready-to-run AF :class:`agent_framework.Agent` whose LLM calls are routed through
the in-repo :class:`~agent_service_maf.gateway.llm_gateway.LLMGateway` via
:class:`~agent_service_maf.framework.maf.gateway_chat_client.BifrostChatClient`.

Per-agent model knobs (model / temperature / max_tokens / response_format) are
resolved here. Tools (function bindings + MCP) are **not** built here: they are
constructed per invocation by the adapter (see
:mod:`agent_service_maf.framework.maf.tools`) so each request gets a fresh
``tool_history`` for citation tracking. The source :class:`SKAgentDefinition` is
retained on :class:`BuiltMafAgent` so the adapter knows which tools to build.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import structlog

from agent_service_maf.core.exceptions import AgentInvocationError, ConfigurationError
from agent_service_maf.framework._outcome_schema import build_outcome_model
from agent_service_maf.framework.maf.gateway_chat_client import BifrostChatClient

if TYPE_CHECKING:
    from agent_framework import Agent

    from agent_service_maf.config.validators import SemanticKernelSection, SKAgentDefinition
    from agent_service_maf.gateway.llm_gateway import LLMGateway

logger = structlog.get_logger(__name__)

#: Regex for validating agent names (mirrors the SK builder).
_AGENT_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def _validate_agent_name(name: str) -> None:
    """Validate an agent name against the allowed pattern.

    Args:
        name: Agent name to validate.

    Raises:
        ConfigurationError: If the name does not match ``^[a-zA-Z0-9_-]{1,64}$``.
    """
    if not _AGENT_NAME_RE.match(name):
        raise ConfigurationError(
            f"Invalid agent name '{name}': must match ^[a-zA-Z0-9_-]{{1,64}}$. "
            "Use letters, numbers, hyphens, or underscores, max 64 characters.",
            details={"agent_name": name},
        )


def _sanitize_agent_name(name: str, *, fallback: str = "orchestrator") -> str:
    """Coerce a display-style name into a valid agent name.

    Used for the *synthesized* orchestration manager/router (magentic /
    group_chat / triage), whose ``manager_name`` is a human-friendly label
    (e.g. ``"Triage Agent"``) that a user can set in the UI. That name is only
    an internal routing key (HandoffBuilder participant / turn-limit key), so we
    normalise disallowed characters (spaces, punctuation) to hyphens rather than
    rejecting the run. Runs of invalid chars collapse to one hyphen; leading and
    trailing hyphens are trimmed; the result is capped at 64 chars; an empty
    result falls back to *fallback*. Config-defined participant agents still go
    through the strict :func:`_validate_agent_name`.
    """
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-")[:64].strip("-")
    return cleaned or fallback


class BuiltMafAgent:
    """A fully built Agent Framework agent plus the metadata the adapter needs.

    The adapter reads :attr:`runner` to invoke the agent and :attr:`client` to
    read per-invocation LLM timing / reset usage. The remaining fields back the
    citation + output-schema machinery so the AF adapter produces the same wire
    contract as the SK adapter.

    Attributes:
        name: Agent name.
        instructions: System prompt (also injected into the AF agent).
        description: Agent description.
        model: Resolved model string in ``provider/model-name`` format.
        model_display_name: User-facing registration label for citations / UI.
        temperature: Resolved sampling temperature.
        max_tokens: Resolved max output tokens.
        response_format: ``"json_object"`` / ``"text"`` / ``None`` -- cached so the
            adapter can derive ``expect_json`` without re-reading the SK config.
        output_schema: Default JSON Schema for this agent's output (or ``None``).
        client: The :class:`BifrostChatClient` backing this agent (timing/usage).
        runner: The AF :class:`agent_framework.Agent` instance.
        agent_def: The source config definition, retained so the adapter can build
            this agent's tools (per invocation) from ``tools`` / ``mcp_servers`` /
            ``tool_bindings``.
        default_options: The resolved ``ChatOptions`` mapping (model / temperature /
            max_tokens / response_format) baked into :attr:`runner`. Retained so the
            adapter can rebuild a fresh runner (with tools / orchestration flags
            attached) per invocation via :meth:`make_runner` without re-resolving
            the model knobs.
    """

    def __init__(
        self,
        *,
        name: str,
        instructions: str,
        description: str,
        model: str,
        model_display_name: str | None = None,
        temperature: float,
        max_tokens: int,
        response_format: str | None,
        output_schema: dict[str, Any] | None,
        client: BifrostChatClient,
        runner: Agent,
        agent_def: SKAgentDefinition,
        default_options: dict[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.instructions = instructions
        self.description = description
        self.model = model
        self.model_display_name = model_display_name
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.response_format = response_format
        self.output_schema = output_schema
        self.client = client
        self.runner = runner
        self.agent_def = agent_def
        self.default_options = default_options or {}

    def make_runner(
        self,
        *,
        tools: Any | None = None,  # noqa: ANN401
        require_handoff_persistence: bool = False,
    ) -> Agent:
        """Build a fresh AF :class:`agent_framework.Agent` from this agent's client.

        Used by the orchestration path to attach per-invocation *tools* (so
        orchestrated agents can call functions / MCP just like the single-agent
        path) and to opt into the per-service-call history persistence the
        ``HandoffBuilder`` requires of its participants.

        The new runner shares the same :class:`BifrostChatClient` as :attr:`runner`,
        so usage / timing accumulate on the same counters the adapter reads.

        Args:
            tools: AF tool objects to bind at the agent level. ``None`` runs the
                agent without tools.
            require_handoff_persistence: Set ``require_per_service_call_history_persistence``
                on the agent. Required for ``handoff`` / ``triage`` participants.

        Returns:
            A ready-to-run :class:`agent_framework.Agent`.
        """
        return self.client.as_agent(
            name=self.name,
            instructions=self.instructions or None,
            description=self.description or None,
            default_options=self.default_options,
            tools=tools,
            require_per_service_call_history_persistence=require_handoff_persistence,
        )


class MafModelResolver:
    """Resolves per-agent model settings, falling back to global defaults.

    Resolution order is: agent-specific override -> global default, resolving
    model knobs from the ``semantic_kernel`` config section.
    """

    def __init__(
        self,
        default_model: str,
        default_temperature: float,
        default_max_tokens: int,
    ) -> None:
        self.default_model = default_model
        self.default_temperature = default_temperature
        self.default_max_tokens = default_max_tokens

    def resolve_model(self, agent_def: SKAgentDefinition) -> str:
        """Return the agent's model override or the global default."""
        return agent_def.model or self.default_model

    def resolve_temperature(self, agent_def: SKAgentDefinition) -> float:
        """Return the agent's temperature override or the global default."""
        if agent_def.temperature is not None:
            return agent_def.temperature
        return self.default_temperature

    def resolve_max_tokens(self, agent_def: SKAgentDefinition) -> int:
        """Return the agent's max_tokens override or the global default."""
        if agent_def.max_tokens is not None:
            return agent_def.max_tokens
        return self.default_max_tokens


def friendly_model_label(display_name: str | None, wire_model: str) -> str:
    """Return the user-facing model label for playground provenance."""
    if display_name and display_name.strip():
        return display_name.strip()
    if "/" in wire_model:
        return wire_model.rsplit("/", 1)[-1]
    return wire_model


class MafAgentBuilder:
    """Builds :class:`BuiltMafAgent` instances from SK-section config definitions.

    Args:
        gateway: LLMGateway routing every agent's LLM calls through Bifrost.
        mcp_registry: MCP registry for tool access. Accepted for parity with the
            SK builder; tool wiring lands in Phase 2 so it is currently unused.
        default_model: Global default model string.
        default_temperature: Global default temperature.
        default_max_tokens: Global default max tokens.
    """

    def __init__(
        self,
        gateway: LLMGateway,
        mcp_registry: Any | None,  # noqa: ANN401
        default_model: str,
        default_temperature: float,
        default_max_tokens: int,
    ) -> None:
        self._gateway = gateway
        self._mcp_registry = mcp_registry
        self._model_resolver = MafModelResolver(
            default_model=default_model,
            default_temperature=default_temperature,
            default_max_tokens=default_max_tokens,
        )

    def build_agent(self, agent_def: SKAgentDefinition) -> BuiltMafAgent:
        """Build a single AF agent from its config definition.

        Args:
            agent_def: Agent configuration from the SK section.

        Returns:
            A :class:`BuiltMafAgent` with an AF agent ready to run.

        Raises:
            ConfigurationError: If the agent name is invalid.
        """
        _validate_agent_name(agent_def.name)

        model = self._model_resolver.resolve_model(agent_def)
        model_display_name = getattr(agent_def, "model_display_name", None)
        temperature = self._model_resolver.resolve_temperature(agent_def)
        max_tokens = self._model_resolver.resolve_max_tokens(agent_def)
        response_format = getattr(agent_def, "response_format", None)
        output_schema = getattr(agent_def, "output_schema", None)

        # Force None unless it's a dict AND a buildable JSON Schema (Pydantic check).
        if isinstance(output_schema, dict) and build_outcome_model(output_schema) is not None:
            pass
        else:
            if output_schema is not None:
                logger.warning(
                    "structured_output_schema_invalid_ignored",
                    agent_name=agent_def.name,
                )
            output_schema = None

        client = BifrostChatClient(
            gateway=self._gateway,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
        )

        # default_options flow through AF's ChatOptions into BifrostChatClient's
        # ``_inner_get_response`` so every ``runner.run()`` carries the agent's
        # resolved model knobs without the adapter re-passing them per call.
        default_options: dict[str, Any] = {
            "model": model,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        # Provider response_format is derived solely from a valid structuredOutput
        # schema (populated only when structuredOutput.enabled != false).
        if output_schema is not None:
            default_options["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": agent_def.name or "structured_output",
                    "schema": output_schema,
                },
            }

        runner = client.as_agent(
            name=agent_def.name,
            instructions=agent_def.instructions or None,
            description=agent_def.description or None,
            default_options=default_options,
        )

        return BuiltMafAgent(
            name=agent_def.name,
            instructions=agent_def.instructions,
            description=agent_def.description,
            model=model,
            model_display_name=model_display_name,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format=response_format,
            output_schema=output_schema,
            client=client,
            runner=runner,
            agent_def=agent_def,
            default_options=default_options,
        )

    def build_manager_agent(
        self,
        *,
        model: str,
        temperature: float = 0.0,
        name: str = "orchestrator",
        instructions: str = "",
        max_tokens: int | None = None,
        description: str = "",
        function_choice_behavior: str = "auto",
        model_display_name: str | None = None,
    ) -> BuiltMafAgent:
        """Build an orchestration *manager* agent (Magentic / group-chat / triage).

        Unlike :meth:`build_agent` this does not come from a config
        :class:`SKAgentDefinition`; it is synthesized from the orchestration
        manager knobs (``manager_model`` / ``manager_temperature`` /
        ``manager_instructions`` / ``manager_max_tokens``). The returned agent
        shares the same gateway-backed client machinery so its LLM usage is
        tracked and can be aggregated alongside the participants.

        ``function_choice_behavior`` defaults to ``"auto"`` (the manager *may*
        emit a handoff / function call). Triage callers should pass
        ``"required"`` so the router LLM is forced to call one of the injected
        handoff functions instead of replying in prose — the prose-instead-of-
        handoff failure mode is what made the manager's text masquerade as a
        regular reply with no trace entry. ``"none"`` is rejected because it
        would disable the handoff machinery entirely.

        Args:
            model: Resolved manager model string.
            temperature: Manager sampling temperature.
            name: Agent name (validated like any other agent name).
            instructions: Optional system prompt for the manager.
            max_tokens: Optional max output tokens for the manager response.
            description: Optional manager description (surfaced in traces).
            function_choice_behavior: ``"auto"`` (default) or ``"required"``.

        Returns:
            A :class:`BuiltMafAgent` for the manager.
        """
        if function_choice_behavior == "none":
            raise ConfigurationError(
                "Manager agent cannot disable function_choice_behavior; "
                "set to 'auto' or 'required'.",
                details={"function_choice_behavior": function_choice_behavior},
            )
        from agent_service_maf.config.validators import SKAgentDefinition

        # The manager is synthesized, and ``name`` may be a human-friendly label
        # (e.g. a UI-set "Triage Agent" with a space). Normalise it to a valid
        # agent name so a friendly label never crashes the orchestration.
        #
        # NOTE: ``model_display_name`` is passed through verbatim — it is the
        # *model's* provenance label (fed to ``friendly_model_label`` →
        # citation ``model``), NOT an agent display name. Do not fall back to
        # ``name`` here: that leaked the agent name (e.g. "Triage Agent") into
        # the model label in the playground provenance UI.
        safe_name = _sanitize_agent_name(name)

        mgr_def = SKAgentDefinition(  # type: ignore[call-arg]
            name=safe_name,
            description=description,
            instructions=instructions,
            model=model,
            model_display_name=model_display_name,
            temperature=temperature,
            max_tokens=max_tokens,
            function_choice_behavior=function_choice_behavior,
        )
        return self.build_agent(mgr_def)

    def build_all_agents(self, config: SemanticKernelSection) -> list[BuiltMafAgent]:
        """Build every agent defined in the config section.

        Args:
            config: The :class:`SemanticKernelSection` with agent definitions.

        Returns:
            List of :class:`BuiltMafAgent` instances in definition order.

        Raises:
            ConfigurationError: If any agent name is invalid or duplicated.
            AgentInvocationError: If no agents are defined.
        """
        if not config.agents:
            raise AgentInvocationError(
                "No agents defined in semantic_kernel.agents config. "
                "Define at least one agent with a name and instructions.",
                details={},
            )

        seen: set[str] = set()
        for agent_def in config.agents:
            if agent_def.name in seen:
                raise ConfigurationError(
                    f"Duplicate agent name '{agent_def.name}' in semantic_kernel.agents config. "
                    "Each agent must have a unique name.",
                    details={"duplicate_name": agent_def.name},
                )
            seen.add(agent_def.name)

        return [self.build_agent(agent_def) for agent_def in config.agents]
