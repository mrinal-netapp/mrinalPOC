"""Team loader — builds TeamBundles from a file, a team blob, or an agent record.

Three entry points cover MAF's three invocation granularities:

1. :func:`build_team_bundle` — read a single team JSON file from disk. The
   file may have agents inlined under ``semantic_kernel.agents[]`` (today's
   ``configs/team/*.json`` shape) or members[] referencing agent IDs. Used
   by the file source (CONFIG_SOURCE=file) and by direct callers in tests.

2. :func:`build_team_bundle_from_team_blob` — given a team record + an
   async ``agent_resolver(pid, aid) -> dict`` callback, fan out to fetch
   each member agent and compose them into a MAF-shaped payload. Used by
   the lazy registry's remote path.

3. :func:`build_team_bundle_from_agent` — wrap one standalone agent record
   in a synthetic single-agent team so the rest of the runtime keeps its
   TeamBundle-centric contract for ``/projects/{pid}/agents/{aid}/invoke``.

All three eventually call :func:`_build_bundle_common`, which is the only
place that constructs ``LLMGateway``, ``MCPManager``, guardrails,
``SessionManager``, and ``TaskManager``. The contract for every downstream
consumer of the resulting ``TeamBundle`` is therefore bit-identical
regardless of source — the executor / adapter / gateway / MCP / session /
task / guardrail / streaming code paths are oblivious to whether the
bundle came from a file, a remote team blob, or a synthetic single-agent
wrap.

Failure isolation: if a single bundle fails to build, the loader yields
an unhealthy ``TeamBundle`` with ``startup_error`` set rather than
raising. The app continues to serve healthy bundles.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import structlog

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.config.remote_adapter import (
    agent_record_to_sk_agent,
    derive_mcp_base_url,
    knowledge_base_record_to_function_binding,
    mcp_server_record_to_inline_config,
    team_blob_to_maf_payload,
)
from agent_service_maf.core.team_bundle import TeamBundle
from agent_service_maf.gateway.llm_gateway import LLMGateway

#: Type alias for the agent-resolution callback supplied by the lazy
#: registry's remote source. Returning ``None`` indicates a 404; the
#: composition step then surfaces the missing member as a startup_error.
AgentResolver = Callable[[str, str], Awaitable[dict[str, Any] | None]]

#: Type alias for the MCP-server resolution callback. Agents in the
#: config-service reference MCP servers by id (``mcpServerIds[]``);
#: the composition step uses this callback to materialise inline
#: ``mcp_servers[]`` configs from those ids. ``None`` from the callback
#: → that id is skipped (warning logged); the team still loads.
MCPServerResolver = Callable[[str, str], Awaitable[dict[str, Any] | None]]

#: Type alias for the knowledge-base resolution callback. Agents
#: reference KBs by id (``knowledgeBaseIds[]``); the composition step
#: uses this callback to fetch each record and synthesise a
#: ``kb_retrieve`` :class:`FunctionBinding`. Same fallback contract
#: as ``MCPServerResolver``.
KBResolver = Callable[[str, str], Awaitable[dict[str, Any] | None]]

logger = structlog.get_logger(__name__)

# Sentinel project_id assigned when a team JSON omits or malforms project_id.
# Such teams are loaded as unhealthy so operators can still see them in
# GET /api/v1/projects/_unknown_/agent-teams; they cannot be invoked.
UNKNOWN_PROJECT_ID = "_unknown_"


def _rag_signature_for(agent_record: dict[str, Any], kb_id: str) -> tuple[tuple, dict[str, Any]]:
    """Extract the per-(agent, kb) ragConfig signature + dict.

    Returns a 2-tuple ``(signature, overrides_dict)`` where:

    - ``signature`` is a hashable tuple suitable for grouping agents
      that share identical retrieval knobs for the same KB. Agents
      with equal signatures get one shared ``kb_retrieve`` binding;
      divergent signatures produce variant bindings (``__r2``,
      ``__r3``) so each agent's tool surface reflects its own config.

    - ``overrides_dict`` is the same content reshaped for
      :func:`knowledge_base_record_to_function_binding`'s
      ``rag_overrides`` parameter. Keys absent from the agent's
      ragConfig are omitted so the helper's defaults apply.

    The ``similarityThresholdEnabled`` toggle is normalised into the
    signature as either ``("off",)`` (threshold disabled — drop the
    param entirely) or ``("on", value-or-None)`` so toggling the
    enable flag triggers a new variant even when the numeric
    threshold itself is unchanged.

    Missing / malformed ragConfig → ``((None, ("on", None), None), {})``
    which collapses to the helper's static defaults — preserving the
    pre-ragConfig behaviour for any agent that doesn't carry one.
    """
    rag = agent_record.get("ragConfig")
    cfg = rag.get(kb_id) if isinstance(rag, dict) else None
    if not isinstance(cfg, dict):
        cfg = {}

    top_k = cfg.get("topK") if isinstance(cfg.get("topK"), (int, float)) else None
    if isinstance(top_k, bool):  # bool is an int subclass; reject.
        top_k = None

    thr_enabled = cfg.get("similarityThresholdEnabled")
    if thr_enabled is False:
        thr_sig: tuple = ("off",)
    else:
        thr_raw = cfg.get("similarityThreshold")
        thr_val = (
            float(thr_raw)
            if isinstance(thr_raw, (int, float)) and not isinstance(thr_raw, bool)
            else None
        )
        thr_sig = ("on", thr_val)

    search_mode_raw = cfg.get("searchMode")
    search_mode = search_mode_raw if isinstance(search_mode_raw, str) and search_mode_raw else None

    signature = (top_k, thr_sig, search_mode)

    overrides: dict[str, Any] = {}
    if top_k is not None:
        overrides["topK"] = top_k
    if thr_sig[0] == "off":
        overrides["similarityThresholdEnabled"] = False
    elif thr_sig[1] is not None:
        overrides["similarityThreshold"] = thr_sig[1]
    if search_mode is not None:
        overrides["searchMode"] = search_mode

    return signature, overrides


def discover_team_config_paths() -> list[Path]:
    """Discover team config paths from environment.

    Priority:
        1. ``AGENT_TEAMS_DIR`` — directory; all ``*.json`` files inside become teams.
        2. ``AGENT_CONFIG_PATH`` — single file fallback (back-compat).

    Returns:
        A list of absolute paths to team config files, sorted by name so the
        default team (first) is deterministic.
    """
    teams_dir = os.environ.get("AGENT_TEAMS_DIR", "").strip()
    if teams_dir:
        d = Path(teams_dir).resolve()
        if not d.is_dir():
            logger.warning("AGENT_TEAMS_DIR does not exist or is not a directory", path=str(d))
            return []
        paths = sorted(d.glob("*.json"))
        logger.info("Team configs discovered", directory=str(d), count=len(paths))
        return paths

    single = os.environ.get("AGENT_CONFIG_PATH", "configs/agent_config.json").strip()
    p = Path(single).resolve()
    if not p.is_file():
        logger.warning("AGENT_CONFIG_PATH does not exist", path=str(p))
        return []
    logger.info("Single-file config mode", path=str(p))
    return [p]


def _read_team_id(config_path: Path) -> tuple[str, str, str, str]:
    """Read the ``_team_id`` / ``_team_name`` / ``_description`` / ``project_id``
    fields without a full schema parse.

    This lets us surface a team in ``GET /api/v1/projects/{pid}/agent-teams`` even
    if later schema validation fails. Falls back to the filename stem for
    ``team_id`` and to :data:`UNKNOWN_PROJECT_ID` when:

    - the file cannot be read or its bytes are not valid JSON,
    - the top level is not a JSON object (e.g., a list at the root),
    - or ``project_id`` is missing / malformed (handled by
      :func:`_coerce_project_id`, which logs its own reason).

    Read/parse failures are logged at WARNING level so operators see the
    underlying exception type and message at startup — without it, a syntax
    error inside the file looks indistinguishable from "forgot to declare
    project_id". The eventual call from :func:`build_team_bundle` to
    :class:`ConfigLoader.resolve` will surface the same exception in
    ``TeamBundle.startup_error`` for visibility on the team-listing route.

    Args:
        config_path: Path to the team JSON config.

    Returns:
        Tuple ``(team_id, name, description, project_id)``.
    """
    stem = config_path.stem
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning(
            "Team config pre-parse failed — marking project unknown until "
            "ConfigLoader surfaces the actual error",
            path=str(config_path),
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return stem, stem, "", UNKNOWN_PROJECT_ID

    if not isinstance(raw, dict):
        logger.warning(
            "Team config top-level is not a JSON object — marking project unknown",
            path=str(config_path),
            top_level_type=type(raw).__name__,
        )
        return stem, stem, "", UNKNOWN_PROJECT_ID

    team_id = str(raw.get("_team_id", stem)).strip() or stem
    name = str(raw.get("_team_name", team_id)).strip() or team_id
    description = str(raw.get("_description", "")).strip()
    project_id = _coerce_project_id(raw.get("project_id"), config_path)
    return team_id, name, description, project_id


def _coerce_project_id(value: Any, config_path: Path) -> str:  # noqa: ANN401
    """Validate that ``value`` is a UUID string. Returns the canonical lower-
    case form or :data:`UNKNOWN_PROJECT_ID` if absent / malformed.

    Logs a warning when the value is missing or invalid so operators can
    spot misconfigured teams at startup.
    """
    if value is None:
        logger.warning(
            "Team config missing required 'project_id' — marking unknown",
            path=str(config_path),
        )
        return UNKNOWN_PROJECT_ID
    if not isinstance(value, str):
        logger.warning(
            "Team config 'project_id' must be a string UUID — marking unknown",
            path=str(config_path),
            value_type=type(value).__name__,
        )
        return UNKNOWN_PROJECT_ID
    try:
        return str(uuid.UUID(value.strip()))
    except (ValueError, AttributeError):
        logger.warning(
            "Team config 'project_id' is not a valid UUID — marking unknown",
            path=str(config_path),
            value=value,
        )
        return UNKNOWN_PROJECT_ID


def _validate_agent_output_schemas(*, team_id: str, config: Any) -> str:  # noqa: ANN401
    """Pre-flight every agent's ``output_schema`` via :func:`build_outcome_model`.

    Plan §3 #9 / §4 C4: a malformed schema should not silently degrade
    to "no validation" on every invocation. Surface it once at team-load
    time so operators see ``bundle.startup_error`` on
    ``GET /agent-teams``, then continue serving the team with
    validation disabled for the affected agent(s).

    Args:
        team_id: Stable team id, echoed onto the WARNING log.
        config: The resolved :class:`AppConfig` for this team. Looked
            up loosely (``getattr``) so the helper does not crash if
            the SK section is missing or shaped differently.

    Returns:
        Empty string when every agent's schema either is absent or
        builds cleanly. A short human-readable summary otherwise --
        used as the bundle's ``startup_error`` (visible on
        ``GET /agent-teams``).
    """
    from agent_service_maf.framework._outcome_schema import build_outcome_model

    sk = getattr(config, "semantic_kernel", None)
    if sk is None:
        return ""
    agents = list(getattr(sk, "agents", []) or [])
    bad_agents: list[str] = []
    for agent_def in agents:
        schema = getattr(agent_def, "output_schema", None)
        if schema is None:
            continue
        if not isinstance(schema, dict):
            bad_agents.append(getattr(agent_def, "name", "<unnamed>"))
            logger.warning(
                "agent_output_schema_invalid",
                team_id=team_id,
                agent_name=getattr(agent_def, "name", "<unnamed>"),
                reason="output_schema is not a JSON object",
            )
            continue
        if build_outcome_model(schema) is None:
            bad_agents.append(getattr(agent_def, "name", "<unnamed>"))
            logger.warning(
                "agent_output_schema_invalid",
                team_id=team_id,
                agent_name=getattr(agent_def, "name", "<unnamed>"),
                reason="build_outcome_model returned None",
            )
    if not bad_agents:
        return ""
    return (
        f"Agent(s) {', '.join(bad_agents)} have invalid output_schema; "
        "they will run without output validation (best-effort parsing only)."
    )


async def build_team_bundle(
    config_path: Path,
    *,
    vk_resolver: Any = None,  # noqa: ANN401  # ProjectVKResolver
    vk_model_hint: str = "",
) -> TeamBundle:
    """Build a TeamBundle for a single config file on disk.

    MCP servers are NOT connected here — the app lifespan does that in
    parallel so startup time scales with the slowest team, not the sum.

    Args:
        config_path: Absolute path to the team JSON config.
        vk_resolver: Optional per-project VK resolver. See
            :func:`_build_bundle_common` for the contract.
        vk_model_hint: Optional model_id hint for the VK resolver.
            File-mode team configs don't carry per-agent ``modelId``
            in a form the team_blob path extracts, so callers must
            pass this explicitly when wiring a resolver.

    Returns:
        A fully constructed TeamBundle. On failure, returns a bundle
        marked ``healthy=False`` with ``startup_error`` describing the
        problem. It will not raise for routine config errors — only
        programmer errors propagate.
    """
    team_id, name, description, project_id = _read_team_id(config_path)
    logger.info(
        "Building team bundle",
        team_id=team_id,
        project_id=project_id,
        path=str(config_path),
    )

    # ConfigLoader runs first so a genuine parse failure (invalid JSON,
    # schema mismatch, etc.) surfaces as the actual cause in
    # ``startup_error``. Only when the file parsed cleanly **but**
    # ``_read_team_id`` flagged ``project_id`` as unknown do we emit
    # the dedicated "missing project_id" message — at that point the
    # pre-parse is the source of truth because the field was either
    # absent or syntactically not a UUID in an otherwise-valid JSON.
    try:
        loader = ConfigLoader(json_config_path=str(config_path))
        config = loader.resolve()
    except Exception as exc:
        logger.error(
            "Failed to load team config",
            team_id=team_id,
            project_id=project_id,
            path=str(config_path),
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return _unhealthy_bundle(
            team_id=team_id,
            project_id=project_id,
            name=name,
            description=description,
            source_ref=str(config_path),
            startup_error=f"{type(exc).__name__}: {exc}",
        )

    if project_id == UNKNOWN_PROJECT_ID:
        logger.error(
            "Team config has no usable project_id",
            team_id=team_id,
            path=str(config_path),
        )
        return _unhealthy_bundle(
            team_id=team_id,
            project_id=project_id,
            name=name,
            description=description,
            source_ref=str(config_path),
            startup_error=("Team JSON missing or invalid top-level 'project_id' (must be a UUID)."),
        )

    return await _build_bundle_common(
        team_id=team_id,
        project_id=project_id,
        name=name,
        description=description,
        loader=loader,
        source_ref=str(config_path),
        config=config,
        vk_resolver=vk_resolver,
        vk_model_hint=vk_model_hint,
    )


async def build_team_bundle_from_team_blob(
    *,
    team_id: str,
    project_id: str,
    name: str,
    description: str,
    team_payload: dict[str, Any],
    agent_resolver: AgentResolver,
    source_ref: str,
    mcp_server_resolver: MCPServerResolver | None = None,
    kb_resolver: KBResolver | None = None,
    vk_resolver: Any = None,  # noqa: ANN401  # ProjectVKResolver
) -> TeamBundle:
    """Compose a MAF team config from a config-service team record.

    Fans out to fetch each member agent independently via ``agent_resolver``
    (typically :meth:`RemoteConfigCache.get_agent`), splices the resolved
    list into ``semantic_kernel.agents[]``, then hands the composed payload
    to :func:`_build_bundle_common` for ``ConfigLoader.resolve`` and
    runtime construction.

    When ``mcp_server_resolver`` is supplied, every unique MCP-server id
    referenced by any resolved agent's ``mcpServerIds`` is fetched from
    config-service and folded into ``team_payload["mcp_servers"]`` as an
    inline server config (name + transport + Bifrost-routed URL). Each
    agent's ``mcp_servers`` field is rewritten from id → server name so
    MAF's SK adapter — which looks servers up by name — can find them.

    Back-compat path: when the team payload already carries
    ``semantic_kernel.agents[]`` (today's inlined MAF shape), the agents
    are used verbatim — no fan-out is attempted. This lets the file source
    serve existing ``configs/team/*.json`` fixtures byte-for-byte.

    Args:
        team_id: Stable identifier used in routes.
        project_id: UUID of the owning project.
        name: Human-readable name for ``to_public_dict``.
        description: Optional description for ``to_public_dict``.
        team_payload: Raw team record from config-service (or a file).
        agent_resolver: Async callback that returns an agent record dict
            for ``(project_id, agent_id)`` — typically the remote cache's
            ``get_agent``. Returning ``None`` flags the member as a 404.
        source_ref: Human-readable origin (e.g. ``remote:team/{pid}/{tid}``
            or a file path) — stored on the bundle for log breadcrumbs.
        mcp_server_resolver: Optional async callback that returns an MCP
            server record dict for ``(project_id, server_id)`` — typically
            :meth:`RemoteConfigCache.get_mcp_server`. When ``None`` (file
            source), MCP-server id-rewriting is skipped — the inlined
            team fixture is expected to carry ``mcp_servers[]`` already.
        kb_resolver: Optional async callback that returns a KB record
            dict for ``(project_id, kb_id)`` — typically
            :meth:`RemoteConfigCache.get_knowledge_base`. When supplied,
            each agent's ``knowledgeBaseIds`` is fanned out and turned
            into ``kb_retrieve`` :class:`FunctionBinding` entries on the
            team's top-level ``tool_bindings[]``, with the agent's
            ``tool_bindings`` list rewritten to include those binding
            names. ``None`` (file source) skips this pass.

    Returns:
        A fully constructed ``TeamBundle``. Unhealthy on composition or
        validation failure; the executor never sees an unhealthy bundle.
    """
    logger.info(
        "Composing team bundle from team blob",
        team_id=team_id,
        project_id=project_id,
        source_ref=source_ref,
    )

    if project_id == UNKNOWN_PROJECT_ID or not project_id:
        return _unhealthy_bundle(
            team_id=team_id,
            project_id=project_id or UNKNOWN_PROJECT_ID,
            name=name,
            description=description,
            source_ref=source_ref,
            startup_error=("Team record missing or invalid 'project_id' (must be a UUID)."),
        )

    # Back-compat: if the team blob already has agents inlined under
    # ``semantic_kernel.agents``, skip fan-out and use them verbatim.
    sk_section = team_payload.get("semantic_kernel")
    inlined_agents: list[dict[str, Any]] | None = None
    if isinstance(sk_section, dict):
        candidate = sk_section.get("agents")
        if isinstance(candidate, list) and candidate:
            inlined_agents = [a for a in candidate if isinstance(a, dict)]

    composition_warnings: list[str] = []
    # Keep agent records paired with their sk_agent dicts so the KB
    # resolver below can read ``knowledgeBaseIds`` straight from the
    # source record (SKAgentDefinition doesn't carry that field).
    agent_pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    if inlined_agents is not None:
        agent_dicts = inlined_agents
        # When the blob is already MAF-shaped (inlined agents), use it as-is
        # so existing fixtures load unchanged.
        maf_payload = team_payload
    else:
        member_refs = team_payload.get("members", [])
        if not isinstance(member_refs, list):
            member_refs = []
        agent_dicts = []
        for member in member_refs:
            if not isinstance(member, dict):
                continue
            if member.get("memberType", "agent") != "agent":
                # Sub-team support is out of scope for MAF MVP — flag in
                # startup_error so operators see the skipped composition
                # on GET /agent-teams instead of having to scrape logs.
                composition_warnings.append(
                    f"member type {member.get('memberType')!r} is not supported; skipped"
                )
                continue
            aid = (
                member.get("memberId")
                or member.get("agentId")
                or member.get("agent_id")
                or member.get("id")
            )
            if not aid:
                composition_warnings.append("team member missing memberId/agentId; skipped")
                continue
            try:
                agent_record = await agent_resolver(project_id, str(aid))
            except Exception as exc:
                composition_warnings.append(
                    f"agent {aid!r} fetch failed: {type(exc).__name__}: {exc}"
                )
                continue
            if agent_record is None:
                composition_warnings.append(f"agent {aid!r} not found (404)")
                continue
            sk_agent = agent_record_to_sk_agent(agent_record, member)
            agent_pairs.append((agent_record, sk_agent))
            agent_dicts.append(sk_agent)

        # MCP-server resolution. Agents currently carry the raw IDs from
        # ``mcpServerIds`` in their ``mcp_servers`` field — that's what
        # ``agent_record_to_sk_agent`` copies verbatim. Resolve each
        # unique id via the config-service, build inline ``mcp_servers[]``
        # configs, and rewrite agent.mcp_servers from id → server name so
        # MAF's SK adapter (which keys by name) can find them.
        #
        # MCP traffic from MAF must route through the Bifrost gateway —
        # the URL on each config-service record is already a Bifrost
        # endpoint by design and is inlined verbatim.
        if mcp_server_resolver is not None:
            # Derive the Bifrost MCP-proxy base URL once per team load
            # from ``AGENT_GATEWAY__URL`` (read straight from the
            # environment, since ``Settings`` doesn't carry it — that
            # env var is consumed by the regular ConfigLoader env-tier
            # merge to populate ``config.gateway.url``). The per-server
            # URL is then composed as
            # ``{mcp_base_url}/{gatewayServerName}`` — the
            # config-service record's own ``url`` field is ignored.
            gateway_url_env = os.environ.get("AGENT_GATEWAY__URL", "").strip()
            mcp_base_url = derive_mcp_base_url(gateway_url_env) if gateway_url_env else ""

            unique_ids: list[str] = []
            seen: set[str] = set()
            for ad in agent_dicts:
                for sid in ad.get("mcp_servers") or []:
                    if isinstance(sid, str) and sid and sid not in seen:
                        seen.add(sid)
                        unique_ids.append(sid)
            id_to_name: dict[str, str] = {}
            resolved_servers: list[dict[str, Any]] = []
            if unique_ids and not mcp_base_url:
                composition_warnings.append(
                    "AGENT_GATEWAY__URL is unset; cannot derive MCP proxy "
                    "base URL — all agent MCP-server references will be "
                    "dropped from this team"
                )
            for sid in unique_ids:
                if not mcp_base_url:
                    # No gateway URL → can't compose anything; skip.
                    continue
                try:
                    record = await mcp_server_resolver(project_id, sid)
                except Exception as exc:
                    composition_warnings.append(
                        f"mcp server {sid!r} fetch failed: {type(exc).__name__}: {exc}"
                    )
                    continue
                if record is None:
                    composition_warnings.append(
                        f"mcp server {sid!r} not found (404); "
                        "agents referencing it will lose this tool surface"
                    )
                    continue
                inline = mcp_server_record_to_inline_config(record, mcp_base_url=mcp_base_url)
                if inline is None:
                    # Record dropped because either ``name`` or
                    # ``gatewayServerName`` was missing. The latter is
                    # the common case — server isn't registered with
                    # the gateway, so the proxy hop wouldn't route.
                    rec_name = record.get("name") or sid
                    has_gateway = bool(
                        record.get("llmproxyGatewayServerName")
                        or record.get("gatewayServerName")
                        or record.get("gateway_server_name")
                    )
                    if not has_gateway:
                        composition_warnings.append(
                            f"mcp server {rec_name!r} has no "
                            "gatewayServerName; not registered with the "
                            "gateway, skipped"
                        )
                    else:
                        composition_warnings.append(
                            f"mcp server {sid!r} record had no name; skipped"
                        )
                    continue
                id_to_name[sid] = inline["name"]
                resolved_servers.append(inline)

            if resolved_servers:
                # Merge with anything the team blob already carried (rare).
                existing = team_payload.get("mcp_servers")
                merged = list(existing) if isinstance(existing, list) else []
                existing_names = {e.get("name") for e in merged if isinstance(e, dict)}
                for srv in resolved_servers:
                    if srv["name"] not in existing_names:
                        merged.append(srv)
                team_payload = {**team_payload, "mcp_servers": merged}

            # Rewrite each agent's mcp_servers from id → name. Run
            # whenever there were ids to resolve, even if none resolved:
            # an unresolved id must NOT survive as an opaque string, or
            # MAF's MCPManager will try to look up a server name that
            # doesn't exist.
            #
            # ``allowed_tools_by_server`` is keyed by the same identifier
            # config-service emits on ``mcpServerConfig`` (the server's
            # UUID). It MUST be re-keyed in lockstep with ``mcp_servers``
            # or ``build_toolset``'s per-server lookup (which now uses the
            # server *name*) silently fails to match, falling back to the
            # "expose every tool on the server" path. Unresolved ids are
            # dropped just like in the ``mcp_servers`` rewrite -- the
            # whitelist for a server we never registered is meaningless.
            if unique_ids:
                for ad in agent_dicts:
                    rewritten = [
                        id_to_name[s]
                        for s in ad.get("mcp_servers") or []
                        if isinstance(s, str) and s in id_to_name
                    ]
                    ad["mcp_servers"] = rewritten
                    raw_whitelist = ad.get("allowed_tools_by_server")
                    if isinstance(raw_whitelist, dict) and raw_whitelist:
                        ad["allowed_tools_by_server"] = {
                            id_to_name[sid]: tools
                            for sid, tools in raw_whitelist.items()
                            if isinstance(sid, str) and sid in id_to_name
                        }

        # Knowledge-base resolution. Agent records carry
        # ``knowledgeBaseIds`` (not part of SKAgentDefinition, so it's
        # not on the sk_agent dict) plus an optional ``ragConfig`` map
        # keyed by ``kbId`` carrying per-agent retrieval overrides
        # (topK, similarityThreshold, searchMode, …). For each unique
        # ``(kbId, override-signature)`` pair we fetch the KB record
        # once, synthesise a ``kb_retrieve`` FunctionBinding pinned to
        # that override set, inject it into the team-level
        # ``tool_bindings[]``, and append the matching binding's name
        # onto each referencing agent's ``tool_bindings`` list. When
        # multiple agents share a KB but disagree on overrides, each
        # signature gets its own binding (first-seen keeps the bare
        # kb name; subsequent variants get ``__r2``, ``__r3`` suffixes)
        # so the LLM-facing namespace stays predictable for the common
        # "all agents agree" case.
        if kb_resolver is not None:
            # kb_id -> dict[signature_tuple, list[(agent_record, sk_agent)]]
            # Insertion order (Py3.7+) preserves first-seen, which drives
            # the suffix numbering below.
            kb_to_groups: dict[str, dict[tuple, list[tuple[dict[str, Any], dict[str, Any]]]]] = {}
            for agent_record, sk_agent in agent_pairs:
                for kid in agent_record.get("knowledgeBaseIds") or []:
                    if not (isinstance(kid, str) and kid):
                        continue
                    sig, _ = _rag_signature_for(agent_record, kid)
                    kb_to_groups.setdefault(kid, {}).setdefault(sig, []).append(
                        (agent_record, sk_agent)
                    )

            # (agent_id, kb_id) -> binding_name
            agent_kb_to_binding: dict[tuple[str, str], str] = {}
            new_bindings: list[dict[str, Any]] = []

            for kid, groups in kb_to_groups.items():
                try:
                    record = await kb_resolver(project_id, kid)
                except Exception as exc:
                    composition_warnings.append(
                        f"kb {kid!r} fetch failed: {type(exc).__name__}: {exc}"
                    )
                    continue
                if record is None:
                    composition_warnings.append(
                        f"kb {kid!r} not found (404); "
                        "agents referencing it will lose this tool surface"
                    )
                    continue

                group_items = list(groups.items())
                for idx, (sig, agents_in_group) in enumerate(group_items):
                    # Reconstruct the rag_overrides dict from the signature
                    # we used to bucket agents into this group. Using the
                    # first agent's raw ragConfig keeps any future keys
                    # (e.g. rerankerType once it lands) flowing through
                    # without churn here.
                    first_agent_record, _ = agents_in_group[0]
                    _, rag_overrides = _rag_signature_for(first_agent_record, kid)
                    binding = knowledge_base_record_to_function_binding(
                        record,
                        project_id=project_id,
                        rag_overrides=rag_overrides,
                    )
                    if binding is None:
                        composition_warnings.append(f"kb {kid!r} record had no id; skipped")
                        continue
                    if idx > 0:
                        # Suffix to keep variant names unique at the
                        # team-payload level. Truncate first so the
                        # suffix can never push us past the 64-char
                        # FunctionBinding.name regex bound.
                        suffix = f"__r{idx + 1}"
                        base = binding["name"][: max(1, 64 - len(suffix))]
                        binding["name"] = f"{base}{suffix}"
                    new_bindings.append(binding)
                    for agent_record, _sk in agents_in_group:
                        aid = agent_record.get("id")
                        if isinstance(aid, str) and aid:
                            agent_kb_to_binding[(aid, kid)] = binding["name"]
                    _ = sig  # signature is implicit in agents_in_group bucketing

                if len(group_items) > 1:
                    composition_warnings.append(
                        f"kb {kid!r}: agents have divergent ragConfig "
                        f"overrides; emitted {len(group_items)} variant "
                        "binding(s) (suffixed __r2, __r3, …)"
                    )

            if new_bindings:
                # Merge with any existing top-level tool_bindings on the
                # team blob (rare for config-service, common for file
                # fixtures). Dedup by binding name.
                existing = team_payload.get("tool_bindings")
                merged = list(existing) if isinstance(existing, list) else []
                existing_names = {b.get("name") for b in merged if isinstance(b, dict)}
                for b in new_bindings:
                    if b["name"] not in existing_names:
                        merged.append(b)
                        existing_names.add(b["name"])
                team_payload = {**team_payload, "tool_bindings": merged}

            # Append the resolved binding names to each agent's
            # ``tool_bindings`` list (preserving anything that was
            # already there from the source record). Run whenever any
            # (agent, kb) pair resolved.
            if agent_kb_to_binding:
                for agent_record, sk_agent in agent_pairs:
                    kb_ids = agent_record.get("knowledgeBaseIds") or []
                    if not isinstance(kb_ids, list):
                        continue
                    aid = agent_record.get("id")
                    if not (isinstance(aid, str) and aid):
                        continue
                    existing_bindings = list(sk_agent.get("tool_bindings") or [])
                    for kid in kb_ids:
                        if not isinstance(kid, str):
                            continue
                        nm = agent_kb_to_binding.get((aid, kid))
                        if nm is not None and nm not in existing_bindings:
                            existing_bindings.append(nm)
                    sk_agent["tool_bindings"] = existing_bindings

        maf_payload = team_blob_to_maf_payload(team_payload, agent_dicts)

    if not agent_dicts:
        return _unhealthy_bundle(
            team_id=team_id,
            project_id=project_id,
            name=name,
            description=description,
            source_ref=source_ref,
            startup_error=(
                "Team has no resolvable agents: "
                + ("; ".join(composition_warnings) or "members[] empty")
            ),
        )

    # Walk the resolved agent records to find ANY catalog UUID we can
    # use as the VK lookup hint. The resolver only needs one model_id
    # the project's catalog knows about; the VK is project-scoped.
    vk_hint = ""
    for agent_record, _ in agent_pairs:
        vk_hint = _extract_vk_model_hint(agent_record)
        if vk_hint:
            break

    loader = ConfigLoader(json_config_data=maf_payload)
    bundle = await _build_bundle_common(
        team_id=team_id,
        project_id=project_id,
        name=name,
        description=description,
        loader=loader,
        source_ref=source_ref,
        vk_resolver=vk_resolver,
        vk_model_hint=vk_hint,
    )
    # Surface composition warnings on healthy bundles too — same soft-fail
    # pattern the output-schema check uses (plan §3 #9).
    if bundle.healthy and composition_warnings:
        existing = bundle.startup_error.strip()
        warn_msg = "; ".join(composition_warnings)
        bundle.startup_error = (
            f"{existing} | composition warnings: {warn_msg}".strip(" |")
            if existing
            else f"composition warnings: {warn_msg}"
        )
    return bundle


async def build_team_bundle_from_agent(
    *,
    project_id: str,
    agent_id: str,
    agent_payload: dict[str, Any],
    source_ref: str,
    mcp_server_resolver: MCPServerResolver | None = None,
    kb_resolver: KBResolver | None = None,
    vk_resolver: Any = None,  # noqa: ANN401  # ProjectVKResolver
) -> TeamBundle:
    """Wrap a standalone agent record in a synthetic single-agent TeamBundle.

    Used by ``/projects/{pid}/agents/{aid}/invoke`` when no team is named.
    The synthetic team uses ``orchestration.type='single'`` and
    ``team_id = f'_agent_{agent_id}_'`` for registry indexing. From the
    executor's perspective this is indistinguishable from a one-agent
    team loaded from a JSON file today (every invariant in the migration
    plan's table holds).

    Delegates to :func:`build_team_bundle_from_team_blob` by wrapping the
    agent in a synthetic one-member team blob and supplying an inline
    ``agent_resolver`` that returns the already-loaded payload. This
    reuses the team-flow's full MCP-server + KB resolution path; the
    earlier direct-construction implementation silently dropped both
    surfaces, so an agent with ``knowledgeBaseIds`` or ``mcpServerIds``
    loaded with neither tool wired through the synthetic team.

    Args:
        project_id: Owning project's UUID.
        agent_id: The agent's id (the source-of-truth one, not the
            synthetic team_id).
        agent_payload: Raw agent record from config-service.
        source_ref: Human-readable origin (e.g. ``remote:agent/{pid}/{aid}``).
        mcp_server_resolver: Optional MCP-server resolver — same contract
            as the team-blob path.
        kb_resolver: Optional KB resolver — same contract as the team-blob
            path.
        vk_resolver: Optional ``ProjectVKResolver`` — same contract.

    Returns:
        A fully constructed ``TeamBundle`` keyed under
        ``_agent_{agent_id}_``. Unhealthy on validation failure.
    """
    logger.info(
        "Composing synthetic single-agent bundle",
        agent_id=agent_id,
        project_id=project_id,
        source_ref=source_ref,
    )
    synthetic_team_id = f"_agent_{agent_id}_"
    name = str(agent_payload.get("name") or agent_id)
    description = str(agent_payload.get("description") or "")

    if not project_id:
        return _unhealthy_bundle(
            team_id=synthetic_team_id,
            project_id=UNKNOWN_PROJECT_ID,
            name=name,
            description=description,
            source_ref=source_ref,
            startup_error=("Agent record missing 'project_id' for synthetic single-agent bundle."),
        )

    synthetic_team_payload: dict[str, Any] = {
        "_team_id": synthetic_team_id,
        "_team_name": name,
        "_description": description,
        "project_id": project_id,
        "members": [{"memberId": agent_id, "memberType": "agent"}],
        "orchestrationPolicy": "single",
    }

    agent_guardrails = agent_payload.get("guardrails")
    if isinstance(agent_guardrails, dict) and agent_guardrails:
        synthetic_team_payload["guardrails"] = agent_guardrails

    # Lift the agent's memory config onto the synthetic team blob. The
    # team-blob path calls resolve_memory(team_blob), which by design
    # ignores member-agent memory (team-level wins on team invokes). For
    # standalone agent invokes the synthetic team IS the agent, so the
    # agent's memoryContext (and legacy memoryType/memoryConfig) must be
    # propagated up — otherwise resolve_memory falls through to the
    # 20-message framework default and the agent's configured window is
    # silently ignored.
    for src_key, dst_key in (
        ("memoryContext", "memoryContext"),
        ("memory_context", "memoryContext"),
        ("memoryType", "memoryType"),
        ("memory_type", "memoryType"),
        ("memoryConfig", "memoryConfig"),
        ("memory_config", "memoryConfig"),
    ):
        value = agent_payload.get(src_key)
        if value is None or dst_key in synthetic_team_payload:
            continue
        synthetic_team_payload[dst_key] = value

    async def _inline_agent_resolver(
        _project_id: str, requested_agent_id: str
    ) -> dict[str, Any] | None:
        # Single-member synthetic team: only our pre-loaded payload can match.
        # Returning None for any other id surfaces as a composition warning
        # in the team-blob path, which is the right semantics for "not part
        # of this synthetic team".
        if requested_agent_id == agent_id:
            return agent_payload
        return None

    return await build_team_bundle_from_team_blob(
        team_id=synthetic_team_id,
        project_id=project_id,
        name=name,
        description=description,
        team_payload=synthetic_team_payload,
        agent_resolver=_inline_agent_resolver,
        source_ref=source_ref,
        mcp_server_resolver=mcp_server_resolver,
        kb_resolver=kb_resolver,
        vk_resolver=vk_resolver,
    )


def _extract_vk_model_hint(agent_record: dict[str, Any]) -> str:
    """Pull the catalog model UUID from a raw agent record (pre-SK-adapter).

    The VK resolver's ``GET /models/:id`` expects the catalog UUID — not
    the Bifrost-routable form (``provider/model-name``) that the SK
    adapter rewrites the field into. Config-service puts the UUID on
    ``modelId`` and also as ``id`` inside the resolved ``model`` dict.
    Returns ``""`` when no usable hint is found.
    """
    candidate = agent_record.get("modelId") or agent_record.get("model_id")
    if isinstance(candidate, str) and candidate:
        return candidate
    model = agent_record.get("model")
    if isinstance(model, dict):
        for key in ("id", "modelId", "model_id"):
            v = model.get(key)
            if isinstance(v, str) and v:
                return v
    if isinstance(model, str) and model:
        return model
    return ""


def _unhealthy_bundle(
    *,
    team_id: str,
    project_id: str,
    name: str,
    description: str,
    source_ref: str,
    startup_error: str,
) -> TeamBundle:
    """Return an unhealthy placeholder bundle for visibility on
    ``GET /api/v1/projects/{project_id}/agent-teams``.

    All builder entry points use this so unhealthy bundles look identical
    regardless of source.
    """
    return TeamBundle(
        team_id=team_id,
        project_id=project_id,
        name=name,
        description=description,
        config_path=source_ref,
        config_loader=None,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
        gateway=None,  # type: ignore[arg-type]
        mcp_manager=None,  # type: ignore[arg-type]
        guardrails=None,
        session_manager=None,
        task_manager=None,
        healthy=False,
        startup_error=startup_error,
    )


def _inject_project_vk_into_mcp_servers(
    servers: list[Any],
    project_vk: str,
    project_id: str | None = None,
) -> list[Any]:
    """Stamp the per-project Bifrost VK onto network MCP server configs.

    Bifrost's aggregated ``/mcp`` proxy authenticates with the same
    per-project virtual key as chat completions (the gateway has no
    master key), but the inline MCP server configs composed from
    config-service records carry no auth header. Without a bearer the
    ``connect()`` handshake to ``/mcp`` is rejected with 401 and every
    MCP-backed agent fails at run time.

    For each URL-based server (streamable-http / sse — the transports
    that hit Bifrost) that does not already carry an ``Authorization``
    header, add ``Authorization: Bearer <project_vk>``. stdio servers
    (no ``url``) and servers with an operator-supplied auth header are
    left untouched.

    When ``project_id`` is supplied, also stamp ``X-Project-ID`` on those
    same Bifrost-routed servers. Unlike the user-on-behalf-of identity
    (which the MCP SDK cannot attach per-call and so travels via the
    protocol ``_meta`` field — see :mod:`agent_service_maf.mcp._identity_transport`),
    the project is fixed for the whole per-project VK connection, so it is
    safe to bake in at connect-time. Bifrost forwards it to each upstream
    per that client's ``allowed_extra_headers`` allowlist, which platform
    MCP servers that enforce tenant isolation require — e.g. the
    analytics-datasets engine rejects requests with no project context
    (HTTP 403), and artifact-store scopes its ACL/audit by project.

    Args:
        servers: Inline ``mcp_servers[]`` entries (raw dicts) as composed
            for the team.
        project_vk: The project's Bifrost virtual-key bearer token.
        project_id: The owning project id. When set, stamped as
            ``X-Project-ID`` on each VK-injected server.

    Returns:
        A new list; entries needing the header are shallow-copied so the
        caller's original dicts are not mutated.
    """
    patched: list[Any] = []
    for srv in servers:
        if not isinstance(srv, dict) or not srv.get("url"):
            patched.append(srv)
            continue
        headers = dict(srv.get("headers") or {})
        if any(k.lower() == "authorization" for k in headers):
            # Operator-supplied auth (external MCP) — leave untouched and
            # do not leak project identity to third-party servers.
            patched.append(srv)
            continue
        headers["Authorization"] = f"Bearer {project_vk}"
        if project_id and not any(k.lower() == "x-project-id" for k in headers):
            headers["X-Project-ID"] = project_id
        new_srv = dict(srv)
        new_srv["headers"] = headers
        patched.append(new_srv)
    return patched


async def _build_bundle_common(
    *,
    team_id: str,
    project_id: str,
    name: str,
    description: str,
    loader: ConfigLoader,
    source_ref: str,
    config: Any = None,  # noqa: ANN401  # AppConfig — looser type to avoid import cycle
    vk_resolver: Any = None,  # noqa: ANN401  # ProjectVKResolver — looser type to avoid import cycle
    vk_model_hint: str = "",  # Optional catalog-UUID hint for the resolver
) -> TeamBundle:
    """Shared tail: ``ConfigLoader.resolve`` → gateway / MCP / guardrails /
    session / task construction.

    Identical to today's ``build_team_bundle`` from the ``ConfigLoader``
    call onward — every Execution-Behavior Invariant from the migration
    plan (LLMGateway construction, MCPManager, guardrails, SessionManager,
    TaskManager, output-schema validation) goes through this function so
    callers cannot diverge.

    Args:
        config: When supplied, the caller has already resolved the
            loader (e.g. ``build_team_bundle`` resolves up front so the
            project_id pre-parse can branch the error message). When
            ``None``, this function resolves the loader itself — every
            other builder entry point relies on that path.
        vk_resolver: Optional :class:`~agent_service_maf.gateway.ProjectVKResolver`.
            When supplied, the team's :class:`LLMGateway` is wired with
            the per-project Bifrost virtual-key fetched from
            config-service rather than the deployment-wide
            ``AGENT_GATEWAY__API_KEY`` env var — mirrors the legacy
            agent-service flow. On VK lookup failure the bundle goes
            unhealthy with the resolver's error message (NEVER falls
            back to the env var on per-project chat-completion paths).
    """
    if config is None:
        try:
            config = loader.resolve()
        except Exception as exc:
            logger.error(
                "Failed to resolve team config",
                team_id=team_id,
                project_id=project_id,
                source_ref=source_ref,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            return _unhealthy_bundle(
                team_id=team_id,
                project_id=project_id,
                name=name,
                description=description,
                source_ref=source_ref,
                startup_error=f"{type(exc).__name__}: {exc}",
            )

    # ---- Per-project VK injection (mirrors legacy agent-service) ---------
    # When a resolver is wired, override `config.gateway.api_key` with the
    # project's Bifrost VK fetched from config-service. The deployment-wide
    # env var stays a config field (used by non-per-project paths) but
    # never feeds per-team chat completions when the resolver is on.
    #
    # The same VK also authenticates this project's MCP tools: Bifrost's
    # aggregated ``/mcp`` proxy has no master key, so it is stamped onto
    # the MCP server configs below (see the MCPManager construction).
    project_vk: str | None = None
    if vk_resolver is not None and project_id:
        from agent_service_maf.gateway import MissingProjectVirtualKeyError

        # The VK is per-project, not per-model — but config-service
        # exposes it as a side-channel on ``GET /models/:id``, so we
        # need *some* registered model_id as the lookup key. Callers
        # extract this from the raw agent record (the agent's
        # ``modelId`` field) and thread it in as ``vk_model_hint``.
        # If no hint is available, we fail loudly here instead of
        # falling back to ``gateway.default_model`` — that field is a
        # cluster-wide chat-completion default (e.g.
        # ``anthropic/claude-sonnet-4-20250514``) that has nothing to
        # do with the project's model catalog and would produce a
        # misleading 404. Operator action: register the agent's model
        # in config-service or set ``agent.modelId`` explicitly.
        if not vk_model_hint:
            startup_error = (
                "MissingProjectVirtualKeyError: cannot resolve Bifrost VK — "
                "no agent in this team carries a `modelId` we can use as the "
                "lookup key against config-service's /models/:id endpoint. "
                "Register the agent's model in config-service or set "
                "`agent.modelId` explicitly."
            )
            logger.error(
                "team_bundle_missing_project_vk",
                team_id=team_id,
                project_id=project_id,
                source_ref=source_ref,
                error=startup_error,
            )
            return _unhealthy_bundle(
                team_id=team_id,
                project_id=project_id,
                name=name,
                description=description,
                source_ref=source_ref,
                startup_error=startup_error,
            )
        try:
            project_vk = await vk_resolver.get_for_project(project_id, vk_model_hint)
        except MissingProjectVirtualKeyError as exc:
            logger.error(
                "team_bundle_missing_project_vk",
                team_id=team_id,
                project_id=project_id,
                source_ref=source_ref,
                error=str(exc),
            )
            return _unhealthy_bundle(
                team_id=team_id,
                project_id=project_id,
                name=name,
                description=description,
                source_ref=source_ref,
                startup_error=f"MissingProjectVirtualKeyError: {exc}",
            )
        # GatewaySection is frozen; copy-with-update preserves every other field.
        config = config.model_copy(
            update={"gateway": config.gateway.model_copy(update={"api_key": project_vk})}
        )

    try:
        # Imported lazily to avoid a circular import at module load:
        # mcp_manager -> config.validators -> config.__init__ -> file_loader ->
        # team_loader. Deferring this keeps team_loader import-order independent.
        from agent_service_maf.mcp.mcp_manager import MCPManager

        gateway = LLMGateway(config.gateway)

        inline_servers = getattr(config, "mcp_servers", None)
        if project_vk and isinstance(inline_servers, list) and inline_servers:
            # Bifrost's aggregated ``/mcp`` proxy is governed by the SAME
            # per-project virtual key as chat completions (the gateway has
            # no master key). The MCP server configs composed from
            # config-service carry no auth header, so without this the
            # connect() handshake to ``/mcp`` returns 401 and every
            # MCP-backed agent fails at run time. Stamp the VK as
            # ``Authorization: Bearer`` on each Bifrost-routed (URL-based)
            # MCP server, leaving any operator-supplied auth untouched.
            # Also stamp ``X-Project-ID`` (connection-scoped) so Bifrost can
            # forward it to tenant-isolated platform MCPs (analytics-datasets
            # rejects requests without project context — HTTP 403).
            inline_servers = _inject_project_vk_into_mcp_servers(
                inline_servers, project_vk, project_id=project_id
            )
        mcp_manager = MCPManager(
            config=config.mcp,
            inline_servers=inline_servers,
        )

        guardrails = None
        if config.guardrails.enabled:
            from agent_service_maf.guardrails.registry import GuardrailRegistry

            guardrails = GuardrailRegistry.build_pipeline(config.guardrails)

        session_manager = await _build_session_manager(config, gateway)
        task_manager = _build_task_manager(config)

        # Option B (plan §3 #9 / §4 C4): validate each agent's
        # output_schema at team-load time so a malformed schema is
        # visible to operators on GET /agent-teams as
        # ``bundle.startup_error`` instead of failing silently at the
        # first invocation.
        output_schema_startup_error = _validate_agent_output_schemas(
            team_id=team_id,
            config=config,
        )

        return TeamBundle(
            team_id=team_id,
            project_id=project_id,
            name=name,
            description=description,
            config_path=source_ref,
            config_loader=loader,
            config=config,
            gateway=gateway,
            mcp_manager=mcp_manager,
            guardrails=guardrails,
            session_manager=session_manager,
            task_manager=task_manager,
            healthy=True,
            startup_error=output_schema_startup_error,
        )
    except Exception as exc:
        logger.error(
            "Failed to build team bundle resources",
            team_id=team_id,
            project_id=project_id,
            source_ref=source_ref,
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return _unhealthy_bundle(
            team_id=team_id,
            project_id=project_id,
            name=name,
            description=description,
            source_ref=source_ref,
            startup_error=f"{type(exc).__name__}: {exc}",
        )


async def _build_session_manager(config: Any, gateway: Any) -> Any:  # noqa: ANN401
    """Instantiate and start a SessionManager if memory is enabled.

    Mirrors the single-team logic previously inline in ``api.py``. Returns
    ``None`` when ``config.memory.enabled`` is False.

    When ``memory.buffer_type == "summary"``, builds a gateway-backed
    summarization function (MEM-3.5). The function is bounded by
    ``memory.summary_timeout_seconds`` and on any error
    :class:`~agent_service_maf.core.memory_buffer.SummaryBuffer` falls
    back to sliding-window trim (dropping the oldest messages, no
    summary message produced). Summarization never blocks a turn for
    more than the configured ceiling.
    """
    mem = config.memory
    if not mem.enabled:
        return None

    from agent_service_maf.core.memory_buffer import create_memory_buffer
    from agent_service_maf.core.session import SessionManager
    from agent_service_maf.core.session_store import create_session_store

    store = create_session_store(
        backend=mem.storage_backend,
        redis_url=mem.redis_url,
        redis_sentinel_url=mem.redis_sentinel_url,
        redis_sentinel_master=mem.redis_sentinel_master,
        redis_password=mem.redis_password,
        key_prefix=mem.redis_key_prefix,
        index_prefix=mem.redis_index_prefix,
        meta_prefix=mem.redis_meta_prefix,
        ttl_seconds=mem.ttl_seconds,
        compression_level=mem.compression_level,
    )

    summarize_fn = None
    if mem.buffer_type == "summary":
        summarize_fn = _build_summarize_fn(
            gateway=gateway,
            model=_resolve_summary_model(config, mem),
            timeout_seconds=getattr(mem, "summarizer_timeout_seconds", 5.0),
            max_tokens=getattr(mem, "summary_max_tokens", 512),
        )

    # Stage 3 — read new MemoryContext-derived knobs.
    #
    # ``adaptive_summarize_threshold`` may arrive flat on MemorySection
    # (Stage 2 mapper) OR nested under ``adaptive_summarize.overflow_threshold``
    # (raw memoryContext shape via MemorySection's extra="allow"). Honor
    # both so hand-written team JSON works regardless of which form was
    # used.
    adaptive_threshold = float(getattr(mem, "adaptive_summarize_threshold", 0.0) or 0.0)
    adaptive_block = getattr(mem, "adaptive_summarize", None)
    if isinstance(adaptive_block, dict):
        nested_threshold = adaptive_block.get("overflow_threshold")
        if isinstance(nested_threshold, (int, float)):
            adaptive_threshold = float(nested_threshold)

    buffer = create_memory_buffer(
        buffer_type=mem.buffer_type,
        max_messages=mem.max_history_length,
        max_chars=mem.max_chars_per_session,
        max_tokens=mem.max_tokens_per_session,
        summarize_fn=summarize_fn,
        summary_refresh_every_turns=int(getattr(mem, "summary_refresh_every_turns", 0) or 0),
        adaptive_summarize_threshold=adaptive_threshold,
    )
    sm = SessionManager(
        ttl_seconds=mem.ttl_seconds,
        max_history_length=mem.max_history_length,
        max_tokens_per_session=mem.max_tokens_per_session,
        cleanup_interval_seconds=mem.cleanup_interval_seconds,
        store=store,
        memory_buffer=buffer,
        max_session_bytes=mem.max_session_bytes,
        max_session_messages=mem.max_session_messages,
        max_sessions_per_user=mem.max_sessions_per_user,
    )
    await sm.start()
    return sm


def _resolve_summary_model(config: Any, mem: Any) -> str:  # noqa: ANN401
    """Resolve which model the summary buffer should call.

    Fallback chain (matches the locked memory-context defaults order
    "agent → manager → first agent"):

    1. ``mem.summary_model`` — explicit per-team / per-agent override.
    2. ``config.semantic_kernel.orchestration.manager_model`` — for
       team configs, the manager's model is the operator's curated
       choice for "the model that orchestrates the team", so it's a
       natural default for the summary too.
    3. First agent's gateway-routable model from
       ``config.semantic_kernel.agents[]`` — guaranteed by
       :func:`agent_record_to_sk_agent` to be a Bifrost-routable
       ``gatewayModelId`` for production teams. For standalone agent
       invocations this is the agent's own model.
    4. ``config.agent.model`` — framework-level default (may be a
       provider-prefixed string baked from defaults).
    5. ``config.gateway.default_model`` — last resort.

    Step 3 matters because the static ``agent.model`` default
    (``anthropic/claude-...``) often points at a provider Bifrost
    doesn't have configured for this cluster, causing every summary
    call to fail with "provider: not found" even though the team's
    actual agent invokes work fine. Picking the agent's resolved model
    keeps the summary path on a model the gateway can route.
    """
    explicit = getattr(mem, "summary_model", "") or ""
    if explicit:
        return explicit

    sk = getattr(config, "semantic_kernel", None)
    if sk is not None:
        # Manager model (team orchestration): both ``manager_model`` and the
        # ``magentic_manager_model`` alias are populated by the adapter; check
        # either form.
        orch = getattr(sk, "orchestration", None)
        if orch is not None:
            for attr in ("manager_model", "magentic_manager_model"):
                mgr_model = getattr(orch, attr, None) or (
                    orch.get(attr) if isinstance(orch, dict) else None
                )
                if mgr_model:
                    return str(mgr_model)

        agents = getattr(sk, "agents", None) or []
        for agent in agents:
            agent_model = getattr(agent, "model", None) or (
                agent.get("model") if isinstance(agent, dict) else None
            )
            if agent_model:
                return str(agent_model)

    agent_section = getattr(config, "agent", None)
    if agent_section is not None:
        default_model = getattr(agent_section, "model", "") or ""
        if default_model:
            return default_model

    return getattr(config.gateway, "default_model", "") or ""


def _build_summarize_fn(
    *,
    gateway: Any,  # noqa: ANN401  # LLMGateway typed loosely to avoid import cycles
    model: str,
    timeout_seconds: float,
    max_tokens: int,
) -> Any:  # noqa: ANN401  # callable returns are deliberately generic
    """Construct a gateway-backed summarization function for :class:`SummaryBuffer`.

    The returned coroutine is bounded by ``asyncio.wait_for`` so a slow or
    unresponsive gateway can never block the buffer for more than
    ``timeout_seconds``. Timeouts and gateway errors are re-raised so
    :class:`~agent_service_maf.core.memory_buffer.SummaryBuffer` catches
    them and falls back to sliding-window trim (no summary message is
    emitted, oldest messages drop off). Empty gateway content is
    handled here -- the helper synthesizes the deterministic basic
    summary so callers still get a non-empty string -- but exceptions
    follow the buffer's own fallback path. The session save still
    succeeds in either case.

    Args:
        gateway: The team's :class:`LLMGateway`. Reused for summary calls
            so they go through the same routing, retries, and metrics.
        model: Model id (``provider/name``) to use for summaries.
        timeout_seconds: Per-call ceiling. Hard upper bound regardless
            of gateway-level retries.
        max_tokens: Max output tokens for the summary. The summary is a
            single ``system`` message; keeping it short matters for the
            window.

    Returns:
        An async function ``(messages) -> str`` ready to hand to
        :class:`~agent_service_maf.core.memory_buffer.SummaryBuffer`.
    """
    import asyncio as _asyncio

    from agent_service_maf.core.memory_buffer import SummaryBuffer

    async def summarize(messages: list[Any]) -> str:
        # Reuse the buffer's basic summary as both the LLM prompt input
        # and the fallback. Always include role + content (truncated).
        transcript_lines: list[str] = []
        for m in messages:
            content = (m.content or "").strip()
            if len(content) > 1000:
                content = content[:1000] + "..."
            transcript_lines.append(f"{m.role}: {content}")
        transcript = "\n".join(transcript_lines)

        prompt = [
            {
                "role": "system",
                "content": (
                    "You compress a chat transcript into a concise factual "
                    "summary the assistant can use as long-term memory. "
                    "Preserve names, dates, decisions, open questions, and "
                    "user preferences. Drop pleasantries. Reply in <= 200 "
                    "words; no preamble."
                ),
            },
            {"role": "user", "content": transcript},
        ]
        try:
            response = await _asyncio.wait_for(
                gateway.complete(
                    messages=prompt,
                    model=model,
                    temperature=0.1,
                    max_tokens=max_tokens,
                ),
                timeout=timeout_seconds,
            )
        except Exception as exc:
            logger.warning(
                "summary_llm_call_failed",
                error_type=type(exc).__name__,
                error=str(exc),
                model=model,
                timeout_seconds=timeout_seconds,
            )
            # Re-raise so SummaryBuffer catches it and falls back to
            # sliding-window trim. That keeps the policy in one place.
            raise

        text = (getattr(response, "content", "") or "").strip()
        if not text:
            # Synthesize from basic summary so we still produce something.
            return SummaryBuffer._basic_summary(messages)
        return text

    return summarize


def _build_task_manager(config: Any) -> Any:  # noqa: ANN401
    """Instantiate a TaskManager if ``config.tasks.enabled`` is True.

    Returns ``None`` when async-invoke is disabled. The manager's
    :meth:`~agent_service_maf.core.task_manager.TaskManager.start` /
    :meth:`~agent_service_maf.core.task_manager.TaskManager.close` are driven
    by the FastAPI lifespan in :mod:`agent_service_maf.interface_layer.api`,
    not here -- this builder just wires the store to the manager so the
    bundle is ready to use once the lifespan starts it.
    """
    tasks_cfg = config.tasks
    if not tasks_cfg.enabled:
        return None

    from agent_service_maf.core.task_manager import TaskManager
    from agent_service_maf.core.task_store import create_task_store

    # §5.5.1: effective running TTL must guard against premature
    # eviction of long-running multi-tool agents. Use the larger of the
    # operator-configured floor and ``agent.timeout_seconds + 60`` so a
    # 15-minute agent doesn't 404 from a 10-minute TTL while still
    # computing. Crashed-worker self-clean upper bound is the
    # ``effective_running_ttl`` actually applied to Redis -- i.e.
    # whichever side of the max() wins. If an operator deliberately
    # sets ``running_ttl_seconds`` higher than
    # ``agent.timeout_seconds + 60`` (e.g. to keep slow polling clients
    # served), crashed workers will linger for that longer window.
    effective_running_ttl = max(
        tasks_cfg.running_ttl_seconds,
        config.agent.timeout_seconds + 60,
    )

    store = create_task_store(
        backend=tasks_cfg.backend,
        redis_url=tasks_cfg.redis_url,
        redis_sentinel_url=tasks_cfg.redis_sentinel_url,
        redis_sentinel_master=tasks_cfg.redis_sentinel_master,
        redis_password=tasks_cfg.redis_password,
        key_prefix=tasks_cfg.key_prefix,
        running_ttl_seconds=effective_running_ttl,
        result_ttl_seconds=tasks_cfg.result_ttl_seconds,
        compression_level=tasks_cfg.compression_level,
    )
    return TaskManager(store)
