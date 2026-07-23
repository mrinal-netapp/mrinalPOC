"""Agent-team creation request model for config-service.

A single object holding every field needed to create an agent team via
``POST /api/v1/projects/{projectId}/agent-teams``. ``to_body()`` renders the
camelCase ``CreateAgentTeamRequest`` payload (per config-service spec),
omitting unset (``None``) fields. ``manager`` is conditional: policies such as
``sequential`` run members in order and omit it, while ``collaborate``,
``coordinate`` (magentic-backed), and ``route`` (triage-backed) use an inline
manager block.

``termination_strategy`` mirrors config-service ``terminationStrategy`` /
MAF ``orchestration.termination_strategy`` (snake_case inside the object).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
@dataclass(frozen=True)
class MaximumIterationsTermination:
    """Stop after a fixed number of orchestration iterations."""

    maximum_iterations: int
    type: Literal["maximum_iterations"] = "maximum_iterations"

    @classmethod
    def with_iterations(cls, maximum_iterations: int) -> MaximumIterationsTermination:
        """Build a maximum-iterations termination strategy."""
        return cls(maximum_iterations=maximum_iterations)

    def to_body(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "maximum_iterations": self.maximum_iterations,
        }


@dataclass(frozen=True)
class KeywordTermination:
    """Stop when any keyword appears in a model response."""

    keywords: tuple[str, ...]
    type: Literal["keyword"] = "keyword"

    @classmethod
    def with_keywords(cls, *keywords: str) -> KeywordTermination:
        """Build a keyword termination strategy."""
        return cls(keywords=keywords)

    def to_body(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "keywords": list(self.keywords),
        }


@dataclass(frozen=True)
class TimeoutTermination:
    """Stop after a wall-clock timeout (seconds)."""

    timeout_seconds: int
    type: Literal["timeout"] = "timeout"

    @classmethod
    def with_seconds(cls, timeout_seconds: int) -> TimeoutTermination:
        """Build a timeout termination strategy."""
        return cls(timeout_seconds=timeout_seconds)

    def to_body(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "timeout_seconds": self.timeout_seconds,
        }


TerminationStrategyLeaf = (
    MaximumIterationsTermination | KeywordTermination | TimeoutTermination
)


@dataclass(frozen=True)
class AggregatorTermination:
    """Compose multiple leaf strategies with ``any`` / ``all`` semantics."""

    condition: Literal["any", "all"]
    sub_strategies: tuple[TerminationStrategyLeaf, ...]
    type: Literal["aggregator"] = "aggregator"

    @classmethod
    def any_of(cls, *sub_strategies: TerminationStrategyLeaf) -> AggregatorTermination:
        """Terminate when any sub-strategy fires."""
        return cls(condition="any", sub_strategies=sub_strategies)

    @classmethod
    def all_of(cls, *sub_strategies: TerminationStrategyLeaf) -> AggregatorTermination:
        """Terminate only when every sub-strategy has fired."""
        return cls(condition="all", sub_strategies=sub_strategies)

    def to_body(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "condition": self.condition,
            "sub_strategies": [strategy.to_body() for strategy in self.sub_strategies],
        }


TeamTerminationStrategy = TerminationStrategyLeaf | AggregatorTermination


@dataclass(frozen=True)
class TeamMemberRef:
    """One entry in a team's ``members`` list."""

    member_type: Literal["agent", "team"]
    member_id: str
    role: str | None = None

    @classmethod
    def agent(cls, member_id: str, *, role: str | None = None) -> TeamMemberRef:
        """Reference an existing agent member."""
        return cls(member_type="agent", member_id=member_id, role=role)

    @classmethod
    def team(cls, member_id: str, *, role: str | None = None) -> TeamMemberRef:
        """Reference an existing nested team member."""
        return cls(member_type="team", member_id=member_id, role=role)

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase member object."""
        body: dict[str, Any] = {
            "memberType": self.member_type,
            "memberId": self.member_id,
        }
        if self.role is not None:
            body["role"] = self.role
        return body


@dataclass(frozen=True)
class TeamManagerConfig:
    """Inline or reference manager block for orchestrated teams."""

    name: str | None = None
    system_prompt: str | None = None
    model_id: str | None = None
    model_class: str | None = None
    agent_id: str | None = None
    role: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    guardrails: dict[str, Any] | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase manager object, omitting unset fields."""
        body: dict[str, Any] = {}
        if self.agent_id is not None:
            body["agent_id"] = self.agent_id
        if self.name is not None:
            body["name"] = self.name
        if self.role is not None:
            body["role"] = self.role
        if self.model_id is not None:
            body["modelId"] = self.model_id
        if self.model_class is not None:
            body["modelClass"] = self.model_class
        if self.system_prompt is not None:
            body["systemPrompt"] = self.system_prompt
        if self.temperature is not None:
            body["temperature"] = self.temperature
        if self.max_tokens is not None:
            body["maxTokens"] = self.max_tokens
        if self.guardrails is not None:
            body["guardrails"] = self.guardrails
        return body


@dataclass(frozen=True)
class TeamCreationRequest:
    """Inputs for a config-service ``CreateAgentTeamRequest``.

    Required: ``name``, ``orchestration_policy`` and at least one entry in
    ``members``. The manager is optional and only emitted when set. Memory
    fields are optional and only included in the body when set: teams carry
    ``memoryType`` / ``memoryConfig`` (team-level conversation memory keyed by
    team id), but — unlike agents — have no ``memoryContext`` block.
    """

    name: str
    orchestration_policy: str
    members: list[TeamMemberRef]
    manager: TeamManagerConfig | None = None
    termination_strategy: TeamTerminationStrategy | None = None
    memory_type: str | None = None
    memory_config: dict[str, Any] | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase request body, omitting unset fields."""
        body: dict[str, Any] = {
            "name": self.name,
            "orchestrationPolicy": self.orchestration_policy,
            "members": [member.to_body() for member in self.members],
        }
        if self.manager is not None:
            body["manager"] = self.manager.to_body()
        if self.termination_strategy is not None:
            body["terminationStrategy"] = self.termination_strategy.to_body()
        if self.memory_type is not None:
            body["memoryType"] = self.memory_type
        if self.memory_config is not None:
            body["memoryConfig"] = self.memory_config
        return body
