"""Evaluation-template request models for config-service.

Typed payloads for ``POST /api/v1/projects/{projectId}/evaluation/agents/templates``
(create) and ``PATCH .../templates/{templateId}`` (partial update). ``to_body()``
renders camelCase JSON, omitting unset fields.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _build_ai_judge(
    *,
    judge_models: list[str] | None,
    judge_dimensions: list[str] | None,
    judge_eval_mode: str | None,
    judge_sampling_mode: str | None,
    judge_stratified_slices: bool | None,
    judge_gate_when_sampled: str | None,
) -> dict[str, Any] | None:
    """Build the ``evaluators.aiJudge`` block when any judge field is set."""
    if not any(
        v is not None
        for v in (
            judge_models,
            judge_dimensions,
            judge_eval_mode,
            judge_sampling_mode,
            judge_stratified_slices,
            judge_gate_when_sampled,
        )
    ):
        return None
    ai_judge: dict[str, Any] = {}
    if judge_models is not None:
        ai_judge["models"] = judge_models
    if judge_dimensions is not None:
        ai_judge["dimensions"] = judge_dimensions
    if judge_eval_mode is not None:
        ai_judge["evalMode"] = judge_eval_mode
    if judge_sampling_mode is not None:
        ai_judge["samplingMode"] = judge_sampling_mode
    if judge_stratified_slices is not None:
        ai_judge["stratifiedSlices"] = judge_stratified_slices
    if judge_gate_when_sampled is not None:
        ai_judge["gateWhenSampled"] = judge_gate_when_sampled
    return ai_judge


@dataclass(frozen=True)
class EvaluationTemplateCreateRequest:
    """Inputs for a config-service ``CreateEvaluationTemplateRequest``."""

    eval_name: str
    agent_id: str | None = None
    agent_team: str | None = None
    strategy: str = "deterministic"
    deterministic_metrics: list[str] | None = None
    judge_models: list[str] | None = None
    judge_dimensions: list[str] | None = None
    judge_eval_mode: str | None = None
    judge_sampling_mode: str | None = None
    judge_stratified_slices: bool | None = None
    judge_gate_when_sampled: str | None = None
    golden_available: bool | None = None
    thresholds: dict[str, Any] | None = None
    description: str | None = None
    labels: list[str] | None = None
    suite: str | None = None
    evaluation_scope: str | None = None
    run_mode: str | None = None
    models: list[str] | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase create-template request body."""
        body: dict[str, Any] = {"evalName": self.eval_name}

        agent: dict[str, str] = {}
        if self.agent_id is not None:
            agent["agentId"] = self.agent_id
        if self.agent_team is not None:
            agent["agentTeam"] = self.agent_team
        if agent:
            body["agent"] = agent

        evaluators: dict[str, Any] = {"strategy": self.strategy}
        if self.deterministic_metrics is not None:
            evaluators["deterministic"] = {"metrics": self.deterministic_metrics}
        ai_judge = _build_ai_judge(
            judge_models=self.judge_models,
            judge_dimensions=self.judge_dimensions,
            judge_eval_mode=self.judge_eval_mode,
            judge_sampling_mode=self.judge_sampling_mode,
            judge_stratified_slices=self.judge_stratified_slices,
            judge_gate_when_sampled=self.judge_gate_when_sampled,
        )
        if ai_judge is not None:
            evaluators["aiJudge"] = ai_judge
        if self.golden_available is not None:
            evaluators["goldenAvailable"] = self.golden_available
        body["evaluators"] = evaluators

        if self.thresholds is not None:
            body["thresholds"] = self.thresholds
        if self.description is not None:
            body["description"] = self.description
        if self.labels is not None:
            body["labels"] = self.labels
        if self.suite is not None:
            body["suite"] = self.suite
        if self.evaluation_scope is not None:
            body["evaluationScope"] = self.evaluation_scope
        if self.run_mode is not None:
            body["runMode"] = self.run_mode
        if self.models is not None:
            body["models"] = self.models
        return body


@dataclass(frozen=True)
class EvaluationTemplateUpdateRequest:
    """Partial update payload for ``PATCH .../templates/{templateId}``."""

    eval_name: str | None = None
    agent_id: str | None = None
    agent_team: str | None = None
    strategy: str | None = None
    deterministic_metrics: list[str] | None = None
    judge_models: list[str] | None = None
    judge_dimensions: list[str] | None = None
    judge_eval_mode: str | None = None
    judge_sampling_mode: str | None = None
    judge_stratified_slices: bool | None = None
    judge_gate_when_sampled: str | None = None
    golden_available: bool | None = None
    thresholds: dict[str, Any] | None = None
    description: str | None = None
    labels: list[str] | None = None
    suite: str | None = None
    evaluation_scope: str | None = None
    run_mode: str | None = None
    models: list[str] | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase patch body, omitting unset fields."""
        body: dict[str, Any] = {}

        if self.eval_name is not None:
            body["evalName"] = self.eval_name

        if self.agent_id is not None or self.agent_team is not None:
            agent: dict[str, str] = {}
            if self.agent_id is not None:
                agent["agentId"] = self.agent_id
            if self.agent_team is not None:
                agent["agentTeam"] = self.agent_team
            body["agent"] = agent

        if (
            self.strategy is not None
            or self.deterministic_metrics is not None
            or self.judge_models is not None
            or self.judge_dimensions is not None
            or self.judge_eval_mode is not None
            or self.judge_sampling_mode is not None
            or self.judge_stratified_slices is not None
            or self.judge_gate_when_sampled is not None
            or self.golden_available is not None
        ):
            evaluators: dict[str, Any] = {}
            if self.strategy is not None:
                evaluators["strategy"] = self.strategy
            if self.deterministic_metrics is not None:
                evaluators["deterministic"] = {"metrics": self.deterministic_metrics}
            ai_judge = _build_ai_judge(
                judge_models=self.judge_models,
                judge_dimensions=self.judge_dimensions,
                judge_eval_mode=self.judge_eval_mode,
                judge_sampling_mode=self.judge_sampling_mode,
                judge_stratified_slices=self.judge_stratified_slices,
                judge_gate_when_sampled=self.judge_gate_when_sampled,
            )
            if ai_judge is not None:
                evaluators["aiJudge"] = ai_judge
            if self.golden_available is not None:
                evaluators["goldenAvailable"] = self.golden_available
            body["evaluators"] = evaluators

        if self.thresholds is not None:
            body["thresholds"] = self.thresholds
        if self.description is not None:
            body["description"] = self.description
        if self.labels is not None:
            body["labels"] = self.labels
        if self.suite is not None:
            body["suite"] = self.suite
        if self.evaluation_scope is not None:
            body["evaluationScope"] = self.evaluation_scope
        if self.run_mode is not None:
            body["runMode"] = self.run_mode
        if self.models is not None:
            body["models"] = self.models
        return body
