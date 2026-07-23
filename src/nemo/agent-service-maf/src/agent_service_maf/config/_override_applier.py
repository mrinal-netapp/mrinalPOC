"""Translate request-level :class:`ConfigOverrides` into :class:`AgentConfig` mutations.

Per §5.1.4 of the migration plan, per-request overrides follow this
precedence order:

    per-agent override > top-level override > team/agent JSON config > defaults

The 3-tier config-loader merge (defaults → env → JSON → request) handles
the right-hand half. This module handles the request half by:

1. Translating ``ConfigOverrides`` (typed wire model) into a nested dict
   that :meth:`ConfigLoader.resolve` can deep-merge into the validated
   :class:`AgentConfig` (top-level ``model`` / ``temperature`` /
   ``max_tokens`` land on ``agent.{model,temperature,max_tokens}``).
2. Applying ``agentOverrides[name]`` and -- on single-agent invokes --
   the top-level overrides directly to the matching
   :class:`SKAgentDefinition` entries inside ``semantic_kernel.agents[]``
   **after** the loader returns its frozen :class:`AgentConfig`. The
   semantic-kernel ``agents`` list cannot be merged by
   :func:`~agent_service_maf.config.config_loader.deep_merge` (lists
   replace wholesale), so the per-agent overrides go in via
   :meth:`pydantic.BaseModel.model_copy`.

Locked fields (``agent.framework``, ``project_id``) cannot appear in
``ConfigOverrides`` by construction (the typed model has no fields for
them), so the defense-in-depth lock check in
:func:`~agent_service_maf.config.config_loader._check_locked_fields` is
a no-op on translated overrides. It still runs and will fail loudly if
a caller-supplied raw dict tries to slip a locked field through.

Wiring:

* :func:`config_overrides_to_request_dict` -- consumed by
  ``bundle.config_loader.resolve(request_overrides=...)``.
* :func:`apply_per_agent_overrides` -- consumed by the invoke /
  stream / async-runner code in
  :mod:`agent_service_maf.interface_layer.routes` immediately after
  :meth:`ConfigLoader.resolve` returns.
* :func:`validate_overrides_against_catalog` -- async helper called from
  the route handler before adapter construction so the §B7 model-catalog
  stub stays drop-in-replaceable with the real config-service-backed
  catalog without touching this module.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:
    from agent_service_maf.config.model_catalog import ModelCatalog
    from agent_service_maf.config.validators import AgentConfig
    from agent_service_maf.interface_layer.models import (
        AgentConfigOverride,
        ConfigOverrides,
    )

logger = structlog.get_logger(__name__)


def config_overrides_to_agent_request_dict(
    overrides: ConfigOverrides | None,
) -> dict[str, Any]:
    """Serialise ``ConfigOverrides`` into a flat dict for
    :class:`~agent_service_maf.core.interfaces.AgentRequest`.

    :class:`AgentRequest` typed ``config_overrides`` as
    ``dict[str, Any]`` so the core domain stays decoupled from the
    interface layer. Adapters that care about overrides may inspect this
    dict; today the only consumer is the §5.1.4 merge done before the
    adapter runs, so the dict is mostly a passthrough for tracing.

    Args:
        overrides: Typed wire model parsed off the request body.

    Returns:
        A possibly-empty dict containing only the non-``None`` fields
        from ``overrides``. ``None`` input yields an empty dict.
    """
    if overrides is None:
        return {}
    return overrides.model_dump(
        mode="python",
        by_alias=False,
        exclude_none=True,
    )


def config_overrides_to_request_dict(
    overrides: ConfigOverrides | None,
) -> dict[str, Any]:
    """Translate top-level ``ConfigOverrides`` into a ``ConfigLoader`` dict.

    Per ``ConfigLoader.resolve``'s contract the returned dict is deep-
    merged into the env / JSON tiers, so only the keys we actually want
    to override appear. Per-agent overrides are handled separately by
    :func:`apply_per_agent_overrides` because the semantic-kernel
    ``agents`` list cannot be merged sensibly.

    Args:
        overrides: The typed wire model parsed off the request body, or
            ``None`` when the request supplied no overrides.

    Returns:
        A possibly-empty dict suitable for
        ``bundle.config_loader.resolve(request_overrides=...)``. An
        empty dict is returned (not ``None``) so the caller can pass it
        unconditionally.
    """
    if overrides is None:
        return {}

    agent_section: dict[str, Any] = {}
    if overrides.model is not None:
        agent_section["model"] = overrides.model
    if overrides.temperature is not None:
        agent_section["temperature"] = overrides.temperature
    if overrides.max_tokens is not None:
        agent_section["max_tokens"] = overrides.max_tokens

    if not agent_section:
        return {}
    return {"agent": agent_section}


def apply_per_agent_overrides(
    config: AgentConfig,
    overrides: ConfigOverrides | None,
    *,
    is_team_invoke: bool,
) -> AgentConfig:
    """Apply ``agentOverrides`` (and single-agent top-level overrides) to ``config``.

    Behavior (§5.1.4):

    * **Single-agent invoke** (``is_team_invoke=False``):
      ``agentOverrides`` is silently ignored. Top-level
      ``model`` / ``temperature`` / ``max_tokens`` are written onto the
      lone :class:`SKAgentDefinition` so the adapter's
      ``agents[0].service.model`` reflects the request. (Top-level
      values already land on ``agent.{...}`` via the loader merge --
      this step makes them effective even when the JSON config pinned
      ``agents[0].model`` to a non-``None`` value.)
    * **Team invoke** (``is_team_invoke=True``):
      Top-level values are propagated to the orchestration manager
      slots that exist on the team config (``manager_model`` /
      ``manager_temperature`` for group-chat,
      ``magentic_manager_model`` / ``magentic_manager_temperature`` for
      magentic). ``agentOverrides[name]`` is applied to the matching
      member by name; unknown names are silently dropped (logged at
      DEBUG).

    The returned :class:`AgentConfig` is a new frozen instance --
    Pydantic's ``model_copy(update={...})`` handles the immutability.

    Args:
        config: The post-loader-merge configuration.
        overrides: The typed request overrides (may be ``None``).
        is_team_invoke: Routing context -- ``True`` for team routes
            (``/projects/{pid}/agent-teams/{tid}/...``), ``False`` for
            single-agent project-default and per-agent routes.

    Returns:
        A possibly-mutated copy of ``config`` with per-agent / manager
        overrides applied. When ``overrides`` is ``None`` (or has no
        applicable values) the original ``config`` instance is
        returned unchanged.
    """
    if overrides is None:
        return config

    sk_section = config.semantic_kernel
    members = list(sk_section.agents)
    member_index = {a.name: i for i, a in enumerate(members)}

    if not is_team_invoke and members:
        # Apply top-level overrides to the lone agent so adapters that
        # read settings from agents[0] (the SK adapter does) see them.
        top_level_updates = _top_level_member_updates(overrides)
        if top_level_updates:
            members[0] = members[0].model_copy(update=top_level_updates)

    if is_team_invoke and overrides.agent_overrides:
        for name, agent_override in overrides.agent_overrides.items():
            idx = member_index.get(name)
            if idx is None:
                logger.debug(
                    "config_override_agent_unknown",
                    agent_name=name,
                    known_agents=sorted(member_index.keys()),
                )
                continue
            updates = _top_level_member_updates(agent_override)
            if updates:
                members[idx] = members[idx].model_copy(update=updates)

    sk_updates: dict[str, Any] = {}
    if is_team_invoke:
        manager_updates = _manager_updates_from_top_level(overrides, sk_section)
        if manager_updates:
            sk_updates.update(manager_updates)

    if not _members_changed(members, sk_section.agents) and not sk_updates:
        return config

    if _members_changed(members, sk_section.agents):
        sk_updates["agents"] = members

    new_sk = sk_section.model_copy(update=sk_updates)
    return config.model_copy(update={"semantic_kernel": new_sk})


def _top_level_member_updates(
    override: ConfigOverrides | AgentConfigOverride,
) -> dict[str, Any]:
    """Return the non-``None`` field subset that maps to ``SKAgentDefinition``."""
    updates: dict[str, Any] = {}
    if override.model is not None:
        updates["model"] = override.model
    if override.temperature is not None:
        updates["temperature"] = override.temperature
    if override.max_tokens is not None:
        updates["max_tokens"] = override.max_tokens
    return updates


def _manager_updates_from_top_level(
    overrides: ConfigOverrides,
    sk_section: Any,  # noqa: ANN401  -- SemanticKernelSection (avoid import cycle)
) -> dict[str, Any]:
    """Build manager-field overrides on the SK section for team invokes.

    Manager slots only exist on group-chat (``manager_model`` /
    ``manager_temperature``) and magentic (``magentic_manager_model`` /
    ``magentic_manager_temperature``). Other orchestration types
    silently ignore top-level overrides at the manager level -- they
    already apply via the ``agent.*`` deep-merge done by the loader and
    propagate to members through SK's per-agent fallback.
    """
    orch = getattr(sk_section, "orchestration", None)
    if orch is None:
        return {}
    orch_type = getattr(orch, "type", "")

    updates: dict[str, Any] = {}
    orch_updates: dict[str, Any] = {}

    if orch_type == "group_chat":
        if overrides.model is not None:
            orch_updates["manager_model"] = overrides.model
        if overrides.temperature is not None:
            orch_updates["manager_temperature"] = overrides.temperature
    elif orch_type == "magentic":
        if overrides.model is not None:
            orch_updates["magentic_manager_model"] = overrides.model
        if overrides.temperature is not None:
            orch_updates["magentic_manager_temperature"] = overrides.temperature

    if orch_updates:
        updates["orchestration"] = orch.model_copy(update=orch_updates)
    return updates


def _members_changed(new_members: list[Any], original_members: list[Any]) -> bool:
    if len(new_members) != len(original_members):
        return True
    return any(a is not b for a, b in zip(new_members, original_members, strict=False))


async def validate_overrides_against_catalog(
    overrides: ConfigOverrides | None,
    catalog: ModelCatalog,
    project_id: str,
) -> ConfigOverrides | None:
    """Resolve every override model through the model catalog.

    For each model id (top-level + each ``agentOverrides[*].model``)
    the catalog is asked for a routable identifier. When the catalog
    is :class:`~agent_service_maf.config.model_catalog.ConfigServiceModelCatalog`
    that swaps the catalog UUID for the Bifrost-routable
    ``gatewayModelId``. When the catalog is
    :class:`~agent_service_maf.config.model_catalog.NoopModelCatalog`
    the id is echoed back unchanged.

    The returned :class:`ConfigOverrides` has its ``model`` (and each
    nested ``agentOverrides[*].model``) replaced by the resolved
    routable string, so every downstream consumer
    (``config_overrides_to_request_dict``, ``apply_per_agent_overrides``,
    ``config_overrides_to_agent_request_dict``) sees the Bifrost-shaped
    value rather than the UUID. The input model is not mutated.

    Args:
        overrides: The typed request overrides (may be ``None``).
        catalog: Catalog implementation -- pass
            :class:`~agent_service_maf.config.model_catalog.NoopModelCatalog`
            or :class:`~agent_service_maf.config.model_catalog.ConfigServiceModelCatalog`.
        project_id: Project id passed to the catalog for per-project
            allowlist resolution.

    Returns:
        A new ``ConfigOverrides`` with ``model`` fields replaced by the
        catalog's resolved id, or the original input when no model
        fields needed updating, or ``None`` when ``overrides`` was
        ``None``.
    """
    if overrides is None:
        return None

    top_level_resolved: str | None = None
    if overrides.model:
        info = await catalog.resolve_model_info(project_id, overrides.model)
        if info is not None:
            top_level_resolved = info.model_id

    agent_updates: dict[str, AgentConfigOverride] | None = None
    if overrides.agent_overrides:
        for name, agent_override in overrides.agent_overrides.items():
            if not agent_override.model:
                continue
            info = await catalog.resolve_model_info(project_id, agent_override.model)
            if info is None or info.model_id == agent_override.model:
                continue
            if agent_updates is None:
                agent_updates = dict(overrides.agent_overrides)
            agent_updates[name] = agent_override.model_copy(
                update={"model": info.model_id},
            )

    updates: dict[str, Any] = {}
    if top_level_resolved is not None and top_level_resolved != overrides.model:
        updates["model"] = top_level_resolved
    if agent_updates is not None:
        updates["agent_overrides"] = agent_updates

    if not updates:
        return overrides
    return overrides.model_copy(update=updates)


__all__ = [
    "apply_per_agent_overrides",
    "config_overrides_to_agent_request_dict",
    "config_overrides_to_request_dict",
    "validate_overrides_against_catalog",
]
