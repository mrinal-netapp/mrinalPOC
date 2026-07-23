"""Orchestration builder -- maps config orchestration types to AF workflows.

AF ships first-class multi-agent **builders** in the
``agent_framework.orchestrations`` package (a separately-versioned sub-package,
installed via the ``agent-framework`` extra) plus the core
:class:`agent_framework.WorkflowBuilder` for arbitrary graphs. Each builder takes
the AF :class:`agent_framework.Agent` participants and ``.build()``\\s a
:class:`agent_framework.Workflow`.

Supported orchestration types:

* ``sequential`` -> :class:`SequentialBuilder` -- a pipeline where each agent
  sees the running conversation and the final agent's response is the output.
* ``concurrent`` -> :class:`ConcurrentBuilder` -- parallel fan-out; the default
  aggregator combines per-agent responses into the output.
* ``handoff`` -> :class:`HandoffBuilder` (autonomous mode) -- agents delegate to
  one another via LLM-driven handoff tool calls along the configured edges.
* ``triage`` -> :class:`HandoffBuilder` with a single router agent that can hand
  off to every other agent (LLM-based smart routing).
* ``group_chat`` -> :class:`GroupChatBuilder` -- multi-round discussion with a
  deterministic round-robin speaker selector (or an LLM orchestrator agent when
  ``selection_strategy.type`` is ``auto`` / ``kernel_function``).
* ``magentic`` -> :class:`MagenticBuilder` -- a Magentic-One manager plans and
  coordinates the participants autonomously.
* ``graph`` -> :class:`agent_framework.WorkflowBuilder` -- agents wired along the
  configured directed edges.

Workflows are built **per invocation** (cheap -- they just wire pre-built agents)
so nothing request-scoped leaks between calls. Participants are prepared by the
adapter (tools attached, handoff-persistence flag set) and passed in alongside
their names so this builder can resolve config references (handoff/graph edges,
group-chat selection) by name.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import structlog

from agent_service_maf.core.exceptions import AgentInvocationError

if TYPE_CHECKING:
    from agent_framework import Agent, Workflow

    from agent_service_maf.config.validators import OrchestrationConfig

logger = structlog.get_logger(__name__)

#: Orchestration types this builder can produce.
SUPPORTED_ORCHESTRATION_TYPES = frozenset(
    {"sequential", "concurrent", "handoff", "triage", "group_chat", "magentic", "graph"}
)

#: Selection-strategy types that drive group chat with an LLM orchestrator agent
#: rather than the deterministic round-robin selector.
_LLM_SELECTION_TYPES = frozenset({"auto", "kernel_function"})

#: Hard ceiling on group-chat / handoff / magentic rounds, so a misconfigured or
#: looping LLM cannot run unboundedly. ``config.max_rounds`` is clamped to this.
_MAX_ROUNDS_CEILING = 50


class MafOrchestrationBuilder:
    """Builds AF :class:`Workflow` objects from config orchestration types.

    Stateless -- a single instance can build a fresh workflow per invocation.
    """

    def build(
        self,
        orchestration_type: str,
        participants: list[Agent],
        *,
        agent_names: list[str],
        config: OrchestrationConfig,
        manager_factory: Callable[[], Agent] | None = None,
        agent_descriptions: list[str] | None = None,
    ) -> Workflow:
        """Build an AF workflow for *orchestration_type* over *participants*.

        Args:
            orchestration_type: One of :data:`SUPPORTED_ORCHESTRATION_TYPES`.
            participants: Prepared AF agent runners (tools attached, and -- for
                handoff/triage -- built with ``require_per_service_call_history_persistence``).
            agent_names: Agent names parallel to *participants* (same order). Used
                to resolve config references (handoff/graph edges, group-chat
                selection, triage router).
            config: The orchestration configuration section.
            manager_factory: Builds the manager / orchestrator agent runner on
                demand (magentic, LLM-selection group chat, triage with a
                dedicated router). Required for those paths.
            agent_descriptions: Optional descriptions parallel to *agent_names*.
                Triage uses these as per-target handoff descriptions so the
                router LLM has a useful signal for picking a specialist.

        Returns:
            A ready-to-run :class:`agent_framework.Workflow`.

        Raises:
            AgentInvocationError: If the type is unsupported or there are too few
                agents for the topology.
        """
        if orchestration_type not in SUPPORTED_ORCHESTRATION_TYPES:
            self._raise_unsupported(orchestration_type)

        if len(participants) == 0:
            raise AgentInvocationError(
                f"Orchestration type '{orchestration_type}' requires at least 1 agent; "
                "define agents in semantic_kernel.agents.",
                details={"orchestration_type": orchestration_type, "agent_count": 0},
            )

        # Degenerate case: a multi-agent orchestration declared with a single
        # member has no second agent to coordinate with / route to. Rather than
        # failing the build (which breaks teams mid-edit, e.g. a UI that lets you
        # pick a type before adding the second agent), run the lone agent as a
        # trivial single-participant sequential workflow. Output, trace, and usage
        # still flow through the normal orchestration path so the response shape
        # is unchanged. Mirrors the prior Agno/SK tolerance of 1-member teams.
        if len(participants) == 1:
            logger.info(
                "single_member_orchestration_fallback",
                orchestration_type=orchestration_type,
                detail="one-member team runs as a single-agent workflow",
            )
            return self._build_sequential(participants)

        name_to_runner: dict[str, Agent] = dict(zip(agent_names, participants, strict=True))

        if orchestration_type == "sequential":
            return self._build_sequential(participants)
        if orchestration_type == "concurrent":
            return self._build_concurrent(participants)
        if orchestration_type == "handoff":
            return self._build_handoff(participants, agent_names, name_to_runner, config)
        if orchestration_type == "triage":
            return self._build_triage(
                participants,
                agent_names,
                name_to_runner,
                config,
                manager_factory=manager_factory,
                agent_descriptions=agent_descriptions,
            )
        if orchestration_type == "group_chat":
            return self._build_group_chat(participants, agent_names, config, manager_factory)
        if orchestration_type == "magentic":
            return self._build_magentic(participants, config, manager_factory)
        # graph
        return self._build_graph(participants, agent_names, name_to_runner, config)

    # ------------------------------------------------------------------
    # Per-topology builders
    # ------------------------------------------------------------------

    @staticmethod
    def _build_sequential(participants: list[Agent]) -> Workflow:
        from agent_framework.orchestrations import SequentialBuilder

        return SequentialBuilder(participants=participants).build()

    @staticmethod
    def _build_concurrent(participants: list[Agent]) -> Workflow:
        from agent_framework.orchestrations import ConcurrentBuilder

        return ConcurrentBuilder(participants=participants).build()

    def _build_handoff(
        self,
        participants: list[Agent],
        agent_names: list[str],
        name_to_runner: dict[str, Agent],
        config: OrchestrationConfig,
    ) -> Workflow:
        """Handoff orchestration -- agents delegate via LLM handoff tool calls.

        Runs in **autonomous mode** (no human-in-the-loop ``request_info`` pause)
        since this is a non-interactive REST/SSE service. Edges come from
        ``config.handoffs``; when none are defined, every agent may hand off to
        every other (fully connected). The start agent is
        ``selection_strategy.initial_agent`` or the first participant.
        """
        from agent_framework.orchestrations import HandoffBuilder

        start_name = self._resolve_start_agent(agent_names, config)
        builder = HandoffBuilder(participants=participants).with_start_agent(
            name_to_runner[start_name]
        )

        edges = self._resolve_handoff_edges(agent_names, name_to_runner, config)
        for source, targets, description in edges:
            builder = builder.add_handoff(source, targets, description=description or None)

        turn_limit = self._bounded_rounds(config)
        builder = builder.with_autonomous_mode(
            turn_limits={name: turn_limit for name in agent_names}
        )
        return builder.build()

    def _build_triage(
        self,
        participants: list[Agent],
        agent_names: list[str],
        name_to_runner: dict[str, Agent],
        config: OrchestrationConfig,
        *,
        manager_factory: Callable[..., Agent] | None = None,
        agent_descriptions: list[str] | None = None,
    ) -> Workflow:
        """Triage / route orchestration -- a router agent delegates to one member.

        AF has no native triage primitive. We implement it as a **single router
        agent whose tools are the members**, each wrapped via
        :meth:`agent_framework.Agent.as_tool`: the router LLM calls exactly one
        specialist tool, that agent runs and returns its answer, and the router
        relays it. This is a true one-hop route -- no conversational
        ``HandoffBuilder`` loop, no interactive ``request_info`` pause, no
        fan-out to unrouted members.

        The router is always synthesized via *manager_factory* (its model /
        instructions come from the team's ``manager`` block, falling back to the
        default model). Every member becomes a specialist tool; the member's
        ``description`` becomes the tool description so the router LLM has a
        per-target routing signal.

        The single router is wrapped in a one-participant
        :class:`SequentialBuilder` workflow so triage flows through the same
        orchestration invoke / stream / response-assembly path as every other
        topology. Specialist turns surface as the router's tool calls -- the
        adapter re-sources their per-agent lifecycle + trace from the
        ``FunctionCallContent`` / ``FunctionResultContent`` in the router's
        stream (see ``_translate_orchestration_event``).
        """
        from agent_framework.orchestrations import SequentialBuilder

        if manager_factory is None:
            raise AgentInvocationError(
                "Triage orchestration requires a router; no manager_factory was provided.",
                details={"orchestration_type": "triage"},
            )

        # Resolve names → descriptions so each specialist tool carries a distinct
        # routing signal (a generic shared description gives the router nothing
        # to route on).
        descriptions_by_name: dict[str, str] = {}
        if agent_descriptions and len(agent_descriptions) == len(agent_names):
            for name, desc in zip(agent_names, agent_descriptions, strict=True):
                descriptions_by_name[name] = desc

        # Every member is a specialist the router can delegate to. as_tool wraps
        # the member's ``.run()`` as a FunctionTool: calling it runs that agent
        # with the router-supplied ``task`` and returns its text. ``name`` is
        # pinned to the member name so the adapter can map the router's tool
        # calls back to the specialist for lifecycle / trace re-sourcing.
        specialist_tools = []
        for sname, runner in zip(agent_names, participants, strict=True):
            desc = descriptions_by_name.get(sname) or (
                f"Delegate the request to the {sname} specialist and return its answer."
            )
            specialist_tools.append(runner.as_tool(name=sname, description=desc, arg_name="task"))

        router = manager_factory(tools=specialist_tools)
        # One-participant sequential workflow: the router's turn (with its
        # specialist tool calls) is the whole run.
        return SequentialBuilder(participants=[router]).build()

    def _build_group_chat(
        self,
        participants: list[Agent],
        agent_names: list[str],
        config: OrchestrationConfig,
        manager_factory: Callable[[], Agent] | None,
    ) -> Workflow:
        """Group chat orchestration -- multi-round discussion.

        Uses a deterministic round-robin speaker selector by default. When
        ``selection_strategy.type`` is ``auto`` / ``kernel_function`` an LLM
        orchestrator agent (built via *manager_factory*) picks the next speaker.
        Termination is bounded by ``max_rounds`` and optionally by the configured
        stop keywords.
        """
        from agent_framework.orchestrations import GroupChatBuilder

        max_rounds = self._bounded_rounds(config)
        termination = self._build_keyword_termination(config)

        selection_type = config.selection_strategy.type
        if selection_type in _LLM_SELECTION_TYPES and manager_factory is not None:
            builder = GroupChatBuilder(
                participants=participants,
                orchestrator_agent=manager_factory(),
                output_from="all",
            )
        else:
            builder = GroupChatBuilder(
                participants=participants,
                selection_func=self._round_robin_selector(agent_names),
                output_from="all",
            )

        builder = builder.with_max_rounds(max_rounds)
        if termination is not None:
            builder = builder.with_termination_condition(termination)
        return builder.build()

    def _build_magentic(
        self,
        participants: list[Agent],
        config: OrchestrationConfig,
        manager_factory: Callable[[], Agent] | None,
    ) -> Workflow:
        """Magentic-One orchestration -- an autonomous planning manager.

        The manager agent (built via *manager_factory* from
        ``magentic_manager_model``) plans and coordinates the participants. Rounds
        are bounded by ``max_rounds``.
        """
        from agent_framework.orchestrations import MagenticBuilder, StandardMagenticManager

        if manager_factory is None:
            raise AgentInvocationError(
                "Magentic orchestration requires a manager model. Set "
                "orchestration.magentic_manager_model (or manager_model) in config.",
                details={"orchestration_type": "magentic"},
            )

        manager = StandardMagenticManager(
            agent=manager_factory(),
            max_round_count=self._bounded_rounds(config),
        )
        return MagenticBuilder(participants=participants, manager=manager).build()

    def _build_graph(
        self,
        participants: list[Agent],
        agent_names: list[str],
        name_to_runner: dict[str, Agent],
        config: OrchestrationConfig,
    ) -> Workflow:
        """Graph orchestration -- agents wired along directed config edges.

        The start executor is ``selection_strategy.initial_agent`` or the first
        agent; when no edges are configured the agents are chained in definition
        order (sequential fallback).
        """
        from agent_framework import WorkflowBuilder

        start_name = self._resolve_start_agent(agent_names, config)
        builder = WorkflowBuilder(start_executor=name_to_runner[start_name], output_from="all")

        if config.edges:
            seen: set[str] = set()
            for edge in config.edges:
                source = self._require_agent(edge.source, name_to_runner, "graph edge source")
                target = self._require_agent(edge.target, name_to_runner, "graph edge target")
                key = f"{edge.source}->{edge.target}"
                if key in seen:
                    continue
                seen.add(key)
                builder = builder.add_edge(source, target)
        else:
            builder = builder.add_chain(participants)

        return builder.build()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_start_agent(agent_names: list[str], config: OrchestrationConfig) -> str:
        """Return the configured initial agent, validated, or the first agent."""
        initial = config.selection_strategy.initial_agent
        if initial:
            if initial not in agent_names:
                raise AgentInvocationError(
                    f"selection_strategy.initial_agent '{initial}' is not a defined agent. "
                    f"Available agents: {sorted(agent_names)}.",
                    details={"initial_agent": initial, "available": sorted(agent_names)},
                )
            return initial
        return agent_names[0]

    @staticmethod
    def _require_agent(
        name: str,
        name_to_runner: dict[str, Agent],
        label: str,
    ) -> Agent:
        """Resolve an agent runner by name or raise a descriptive error."""
        runner = name_to_runner.get(name)
        if runner is None:
            raise AgentInvocationError(
                f"{label} '{name}' is not a defined agent. "
                f"Available agents: {sorted(name_to_runner)}.",
                details={"name": name, "available": sorted(name_to_runner)},
            )
        return runner

    def _resolve_handoff_edges(
        self,
        agent_names: list[str],
        name_to_runner: dict[str, Agent],
        config: OrchestrationConfig,
    ) -> list[tuple[Agent, list[Agent], str]]:
        """Build ``(source, [targets], description)`` handoff edges from config.

        Falls back to a fully-connected graph (every agent can hand off to every
        other) when no ``handoffs`` are configured.
        """
        if not config.handoffs:
            edges: list[tuple[Agent, list[Agent], str]] = []
            for source_name in agent_names:
                targets = [name_to_runner[t] for t in agent_names if t != source_name]
                edges.append((name_to_runner[source_name], targets, ""))
            return edges

        # Group targets by source so each source becomes one add_handoff call.
        grouped: OrderedDict[str, list[str]] = OrderedDict()
        descriptions: dict[str, str] = {}
        for handoff in config.handoffs:
            self._require_agent(handoff.source, name_to_runner, "handoff source")
            self._require_agent(handoff.target, name_to_runner, "handoff target")
            grouped.setdefault(handoff.source, [])
            if handoff.target not in grouped[handoff.source]:
                grouped[handoff.source].append(handoff.target)
            if handoff.description:
                descriptions[handoff.source] = handoff.description

        return [
            (
                name_to_runner[source],
                [name_to_runner[t] for t in targets],
                descriptions.get(source, ""),
            )
            for source, targets in grouped.items()
        ]

    @staticmethod
    def _round_robin_selector(
        agent_names: list[str],
    ) -> Callable[[Any], str]:
        """Return a deterministic round-robin group-chat selection function.

        AF passes a ``GroupChatState`` (``current_round`` + ``participants`` +
        ``conversation``); we cycle participants in definition order so each agent
        gets an equal, predictable turn -- a deterministic ``round_robin`` /
        ``sequential`` selection strategy.
        """
        ordered = list(agent_names)

        def _select(state: Any) -> str:  # noqa: ANN401
            names = list(getattr(state, "participants", {}).keys()) or ordered
            current_round = int(getattr(state, "current_round", 0) or 0)
            return names[current_round % len(names)]

        return _select

    @staticmethod
    def _build_keyword_termination(
        config: OrchestrationConfig,
    ) -> Callable[[list[Any]], bool] | None:
        """Build a keyword-based termination condition from config, if any.

        Returns a predicate over the conversation message list that stops the
        group chat once a configured stop keyword appears in the latest message.

        Termination-type coverage: only ``keyword`` termination has a dedicated
        AF condition here; ``default`` falls through to the round cap
        (:meth:`_bounded_rounds`, which honors ``maximum_iterations``).
        ``timeout`` is implemented as a **wall-clock budget enforced by the adapter**
        (see :meth:`AgentFrameworkAdapter._resolve_orchestration_timeout` /
        ``_run_workflow_graceful``) rather than as a per-turn condition here --
        ``type="timeout"`` yields graceful partial results, other types treat a
        configured ``timeout_seconds`` as a hard cap. The remaining termination
        types -- ``aggregator``, ``kernel_function``, ``approval`` -- are **not**
        implemented: no stored team config uses them, so they degrade gracefully to
        the round-cap fallback (this returns ``None`` for them, leaving
        ``max_rounds`` / ``maximum_iterations`` as the only stop). Add
        ``aggregator`` here first if a config ever adopts it.
        """
        keywords = [kw for kw in config.termination_strategy.keywords if kw]
        if not keywords:
            return None
        lowered = [kw.lower() for kw in keywords]

        def _terminate(messages: list[Any]) -> bool:  # noqa: ANN401
            if not messages:
                return False
            last = messages[-1]
            text = getattr(last, "text", None) or ""
            text_lower = text.lower()
            return any(kw in text_lower for kw in lowered)

        return _terminate

    @staticmethod
    def _bounded_rounds(config: OrchestrationConfig) -> int:
        """Effective round cap: the stricter of ``max_rounds`` / ``maximum_iterations``.

        Stored team configs express their turn limit via
        ``termination_strategy.maximum_iterations`` (e.g. group_chat caps at 15,
        reflection at 6) while leaving ``orchestration.max_rounds`` at its default
        (20). The termination strategy's ``maximum_iterations`` is the
        authoritative turn cap, so we honor whichever is stricter and clamp the
        result to a hard ceiling to prevent a misconfigured / looping LLM from
        running unboundedly.
        """
        candidates = [int(config.max_rounds)]
        max_iter = getattr(config.termination_strategy, "maximum_iterations", None)
        if isinstance(max_iter, int) and max_iter > 0:
            candidates.append(max_iter)
        return max(1, min(min(candidates), _MAX_ROUNDS_CEILING))

    @staticmethod
    def _raise_unsupported(orchestration_type: str) -> None:
        """Raise a descriptive error for unknown orchestration types."""
        raise AgentInvocationError(
            f"Unknown orchestration type '{orchestration_type}'. Supported: "
            "'single', 'sequential', 'concurrent', 'handoff', 'triage', 'group_chat', "
            "'magentic', 'graph'.",
            details={"orchestration_type": orchestration_type},
        )
