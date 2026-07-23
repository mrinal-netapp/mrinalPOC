"""Convert agent config dict to Agno Agent instance.

Agno / litellm SDK imports are warmed eagerly at startup via warm_imports()
so the first request doesn't pay the 10-30 s module-load penalty. The
``agno.models.litellm.LiteLLM`` class is the upstream Agno SDK's LLM wrapper
that AgentStudio uses to talk to the Bifrost gateway over its OpenAI-compatible
endpoint (Bifrost's ``/litellm/v1`` API is its own LiteLLM-compatible shim;
this is not a LiteLLM dependency).

Expensive HTTP lookups (model info, KB metadata) are cached in
per-factory TTLCache instances so they aren't repeated every request.
"""

import asyncio
import os
import time
from typing import TYPE_CHECKING, Any

import httpx
from cachetools import TTLCache
from observability_client_runtime import get_logger

from .mcp_pool import MCPConnectionPool
from .mcp_scope import apply_mcp_tool_policy, scope_mcp_toolkit_to_server
from .config import settings
from .service_auth import ServiceAccountClient
from .model_resolver import ModelResolver

if TYPE_CHECKING:
    from .kb_retrieval import KBRetrievalClient

logger = get_logger()

_Agent = None
_AgnoLLM = None  # Reference to ``agno.models.litellm.LiteLLM`` (upstream SDK class).

MCP_PROMPT_MAX_CHARS = int(os.environ.get("MCP_PROMPT_MAX_CHARS", "4000"))


def _collect_mcp_prompt_fragments(
    resolved_mcp: dict[str, dict],
    project_id: str | None,
) -> list[str]:
    """Collect prompt fragments from all attached MCP servers.

    Each server may contribute:
    - serverInstructions: captured from the MCP InitializeResult at connection time
    - promptFragment: static, platform-defined in the catalog entry

    The {projectId} placeholder in fragments is interpolated with the actual
    project ID when available.
    """
    fragments: list[str] = []
    total_len = 0
    for server_id, scfg in resolved_mcp.items():
        server_instructions = scfg.get("serverInstructions")
        if server_instructions:
            fragments.append(server_instructions)
            total_len += len(server_instructions)

        prompt_fragment = scfg.get("promptFragment")
        if prompt_fragment:
            if project_id:
                prompt_fragment = prompt_fragment.replace("{projectId}", project_id)
            fragments.append(prompt_fragment)
            total_len += len(prompt_fragment)

    if total_len > MCP_PROMPT_MAX_CHARS:
        logger.warning(
            "MCP prompt fragments total %d chars exceeds limit %d; "
            "consider reducing fragment sizes",
            total_len, MCP_PROMPT_MAX_CHARS,
        )

    return fragments


JSON_SCHEMA_TYPE_MAP: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
    "null": type(None),
}


def _resolve_field_type(prop: dict, definitions: dict | None = None) -> type:
    """Convert a JSON Schema property definition to a Python type."""
    from typing import List, Optional
    from pydantic import create_model as _cm
    import uuid

    schema_type = prop.get("type", "string")

    if "$ref" in prop:
        ref_path = prop["$ref"].split("/")[-1]
        if definitions and ref_path in definitions:
            return _resolve_field_type(definitions[ref_path], definitions)
        return dict

    if schema_type == "array":
        items = prop.get("items", {})
        if items:
            item_type = _resolve_field_type(items, definitions)
            return List[item_type]  # type: ignore[valid-type]
        return list

    if schema_type == "object":
        properties = prop.get("properties")
        if properties:
            return _build_nested_model(prop, definitions)
        return dict

    return JSON_SCHEMA_TYPE_MAP.get(schema_type, str)


def _build_nested_model(schema: dict, definitions: dict | None = None) -> type:
    """Recursively create a Pydantic model from a JSON Schema object."""
    from typing import Optional
    from pydantic import create_model
    import uuid

    title = schema.get("title", f"Model_{uuid.uuid4().hex[:8]}")
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))

    fields: dict = {}
    for name, prop in properties.items():
        field_type = _resolve_field_type(prop, definitions)
        if name in required:
            fields[name] = (field_type, ...)
        else:
            fields[name] = (Optional[field_type], None)

    return create_model(title, **fields)


def _build_outcome_model(schema: dict) -> type:
    """Build a Pydantic model from a full JSON Schema (the outcomeSchema)."""
    definitions = schema.get("definitions") or schema.get("$defs") or {}
    return _build_nested_model(schema, definitions)


def _mcp_configs_for_agent(config: dict) -> list[dict]:
    """Return resolved MCP server configs for explicitly attached ``mcpServerIds`` only."""
    resolved = config.get("_resolvedMCPServers") or {}
    configs: list[dict] = []
    for server_id in config.get("mcpServerIds") or []:
        server_config = resolved.get(server_id)
        if server_config:
            configs.append(server_config)
    return configs


def _filter_tools_by_allowed(tools: list, mcp_configs: list[dict]) -> list:
    """Filter loaded MCP tools by per-server allowedTools whitelist."""
    allowed_tools: set[str] = set()
    has_whitelist = False

    for mcp_cfg in mcp_configs:
        server_allowed = mcp_cfg.get("allowedTools")
        if server_allowed is not None:
            has_whitelist = True
            allowed_tools.update(server_allowed)

    if not has_whitelist:
        return tools

    filtered = []
    for tool_or_toolkit in tools:
        if hasattr(tool_or_toolkit, "functions"):
            funcs = [f for f in tool_or_toolkit.functions if f.name in allowed_tools]
            if funcs:
                tool_or_toolkit.functions = funcs
                filtered.append(tool_or_toolkit)
        elif hasattr(tool_or_toolkit, "name"):
            if tool_or_toolkit.name in allowed_tools:
                filtered.append(tool_or_toolkit)
        else:
            filtered.append(tool_or_toolkit)

    return filtered


class AgentFactory:
    def __init__(
        self,
        mcp_pool: MCPConnectionPool,
        kb_client: "KBRetrievalClient | None" = None,
        http_client: httpx.AsyncClient | None = None,
        config_service_url: str = "",
        service_auth: ServiceAccountClient | None = None,
        shared_db: object | None = None,
    ):
        self._mcp_pool = mcp_pool
        self._kb_client = kb_client
        self._http_client = http_client
        self._config_service_url = config_service_url.rstrip("/")
        self._service_auth = service_auth
        self._shared_db = shared_db

        self.model_resolver = ModelResolver(
            http_client=http_client,
            config_service_url=config_service_url,
            service_auth=service_auth,
        )
        self._kb_metadata_cache: TTLCache = TTLCache(
            maxsize=settings.KB_METADATA_CACHE_MAX,
            ttl=settings.KB_METADATA_CACHE_TTL,
        )

    @staticmethod
    def warm_imports() -> None:
        """Eagerly import heavy modules so first request is fast."""
        global _Agent, _AgnoLLM
        from agno.agent import Agent as _A
        from agno.models.litellm import LiteLLM as _L
        _Agent = _A
        _AgnoLLM = _L

    async def _resolve_model_info(self, project_id: str, model_id: str) -> dict | None:
        """Delegate to shared ModelResolver."""
        return await self.model_resolver.resolve_model_info(project_id, model_id)

    async def _resolve_kb_metadata(
        self, project_id: str, kb_ids: list[str],
    ) -> list[dict]:
        """Fetch KB name/description from config-service, with TTL cache."""
        cache_key = f"{project_id}:{','.join(sorted(kb_ids))}"
        cached = self._kb_metadata_cache.get(cache_key)
        if cached is not None:
            logger.info(
                ">>> KB METADATA CACHE HIT  | %s | kbs=%d | cache_size=%d/%d",
                cache_key, len(kb_ids),
                len(self._kb_metadata_cache),
                self._kb_metadata_cache.maxsize,
            )
            return cached

        logger.info(
            ">>> KB METADATA CACHE MISS | %s | kbs=%d | fetching from config-service",
            cache_key, len(kb_ids),
        )
        from .kb_retrieval import fetch_kb_metadata

        auth_hdrs: dict[str, str] = {}
        if self._service_auth:
            try:
                auth_hdrs = await self._service_auth.auth_headers()
            except Exception as exc:
                logger.warning("Failed to get auth headers for KB metadata: %s", exc)

        result = await fetch_kb_metadata(
            self._http_client, self._config_service_url,
            project_id, kb_ids, auth_hdrs,
        )
        self._kb_metadata_cache[cache_key] = result
        kb_names = [m.get("name", "?") for m in result]
        logger.info(
            ">>> KB METADATA CACHED     | %s | kbs=%s | cache_size=%d/%d",
            cache_key, kb_names,
            len(self._kb_metadata_cache),
            self._kb_metadata_cache.maxsize,
        )
        return result

    async def create_from_config(
        self,
        config: dict,
        team_context: bool = False,
        user_label: str | None = None,
    ) -> Any:
        global _Agent, _AgnoLLM

        t_start = time.monotonic()
        agent_id = config.get("id", "unknown")

        logger.info(
            "[AgentFactory] create_from_config START agent=%s name=%s "
            "modelId=%s modelAlias=%s temperature=%s maxTokens=%s "
            "memoryType=%s guardrails=%s outcomeSchema=%s",
            agent_id,
            config.get("name"),
            config.get("modelId"),
            config.get("modelAlias"),
            config.get("temperature"),
            config.get("maxTokens"),
            config.get("memoryType"),
            config.get("guardrails"),
            bool(config.get("outcomeSchema")),
        )

        if _Agent is None or _AgnoLLM is None:
            from agno.agent import Agent as _A
            from agno.models.litellm import LiteLLM as _L
            _Agent, _AgnoLLM = _A, _L

        tools: list[Any] = []

        resolved_mcp = config.get("_resolvedMCPServers", {})
        loaded_server_ids: set[str] = set()

        mcp_timeout = settings.MCP_INIT_TIMEOUT
        skipped_mcp: list[str] = []

        # NOTE: ``server_config["llmproxyGatewayServerName"]`` below is the
        # MCP client name at the **LLM proxy gateway** (Bifrost), NOT the
        # AgentStudio api-gateway / apigateway-service. The unambiguous
        # ``llmproxyGateway*`` naming is used end-to-end (DB column,
        # OpenAPI, Go workflow-engine, GUI, Python). See
        # ``MCPConnectionPool`` docstring for the rename history.
        for server_id in config.get("mcpServerIds", []):
            server_config = resolved_mcp.get(server_id, {})
            if server_config and server_config.get("syncStatus") == "synced":
                try:
                    mcp_tools = await asyncio.wait_for(
                        self._mcp_pool.get_tools(server_id, server_config),
                        timeout=mcp_timeout,
                    )
                    gateway_name = (
                        server_config.get("llmproxyGatewayServerName") or server_id
                    )
                    scope_mcp_toolkit_to_server(mcp_tools, gateway_name)
                    apply_mcp_tool_policy(mcp_tools, gateway_name, server_config)
                    tools.append(mcp_tools)
                    loaded_server_ids.add(server_id)
                except asyncio.TimeoutError:
                    name = server_config.get("llmproxyGatewayServerName", server_id)
                    logger.error(
                        "MCP server %s (%s) timed out after %ds during get_tools "
                        "-- SKIPPING (agent will proceed without this server's tools)",
                        server_id, name, mcp_timeout,
                    )
                    skipped_mcp.append(f"{server_id}({name}):timeout")
                except RuntimeError as exc:
                    name = server_config.get("llmproxyGatewayServerName", server_id)
                    logger.warning(
                        "MCP server %s (%s) is unhealthy -- SKIPPING: %s",
                        server_id, name, exc,
                    )
                    skipped_mcp.append(f"{server_id}({name}):unhealthy")
                except Exception as exc:
                    logger.error(
                        "Failed to load MCP tools for server %s (%s): %s",
                        server_id,
                        server_config.get("llmproxyGatewayServerName"),
                        exc,
                    )
                    skipped_mcp.append(f"{server_id}:error")
            elif server_config:
                logger.warning(
                    "MCP server %s not synced (status=%s), skipping",
                    server_id, server_config.get("syncStatus"),
                )
                skipped_mcp.append(f"{server_id}:not_synced")
            else:
                logger.warning(
                    "MCP server %s not found in _resolvedMCPServers, skipping",
                    server_id,
                )
                skipped_mcp.append(f"{server_id}:not_resolved")

        # Strict scoping: only MCP servers explicitly configured on this agent
        # (`mcpServerIds`) are attached. Any extra entries in `_resolvedMCPServers`
        # are metadata-only and must not become callable tools for this agent.

        if skipped_mcp:
            logger.warning(
                "[AgentFactory] %d MCP server(s) skipped for agent %s: %s",
                len(skipped_mcp), agent_id, skipped_mcp,
            )

        response_model = None
        if config.get("outcomeSchema"):
            try:
                response_model = _build_outcome_model(config["outcomeSchema"])
            except Exception as e:
                logger.warning("Failed to create response model: %s", e)

        project_id = config.get("projectId")
        raw_model_id = config.get("modelId") or None
        model_class = config.get("modelClass") or None

        effective_model_id, model_info = await self.model_resolver.resolve_effective_model(
            project_id, raw_model_id, model_class,
        )

        model_alias = config.get("modelAlias") or effective_model_id

        from .llmproxy_gateway_settings import (
            llmproxy_gateway_api_key_for_model,
            llmproxy_gateway_chat_completions_base,
            llmproxy_gateway_model_id_with_sdk_prefix,
            resolve_llmproxy_gateway_model_id,
        )

        llmproxy_gateway_model_id = resolve_llmproxy_gateway_model_id(model_alias, model_info)

        model_kwargs: dict[str, Any] = {
            # `llmproxy_gateway_model_id` is the Bifrost-ready id baked at registration
            # time (`<bifrost-provider>/<model>`, e.g. `azure/gpt-4o-mini`).
            # We only wrap it with `openai/` so the LiteLLM SDK routes via
            # its OpenAI provider plugin; that prefix is stripped before the
            # request reaches Bifrost.
            "id": llmproxy_gateway_model_id_with_sdk_prefix(llmproxy_gateway_model_id, model_info),
            "api_base": llmproxy_gateway_chat_completions_base(),
            # Per-project Bifrost virtual-key bearer token. The helper
            # reads it from model_info.gatewayApiKey (populated by
            # config-service GET /models/:id from the K8s Secret
            # `as-proj-<projectId>-vk`). It raises
            # MissingProjectVirtualKeyError when the Secret is missing,
            # which surfaces clearly as an agent-build failure instead of
            # silently falling back to the cluster master key (which
            # would bypass team-scoped routing).
            "api_key": llmproxy_gateway_api_key_for_model(model_info),
        }

        config_temperature = config.get("temperature")
        config_top_p = config.get("topP") or config.get("top_p")
        config_max_tokens = config.get("maxTokens")

        # Agno's LiteLLM model class defaults both temperature=0.7 and top_p=1.0
        # and sends both in every request. Vertex AI Claude rejects that
        # combination. Agno's get_request_params drops keys whose value is None,
        # so we explicitly set top_p=None whenever we use temperature (and
        # temperature=None when using top_p only).
        if config_temperature is not None and config_top_p is not None:
            logger.warning(
                "[AgentFactory] Both temperature and top_p configured for agent=%s; "
                "using temperature=%s and dropping top_p=%s",
                agent_id, config_temperature, config_top_p,
            )
            model_kwargs["temperature"] = config_temperature
            model_kwargs["top_p"] = None
        elif config_temperature is not None:
            model_kwargs["temperature"] = config_temperature
            model_kwargs["top_p"] = None
        elif config_top_p is not None:
            model_kwargs["temperature"] = None
            model_kwargs["top_p"] = config_top_p
        else:
            model_kwargs["temperature"] = 0.7
            model_kwargs["top_p"] = None
        if config_max_tokens is not None:
            model_kwargs["max_tokens"] = config_max_tokens

        # Bifrost (and the upstream NetApp LLM gateway it fronts) enforces a
        # `user` field in the JSON body and validates its value (an identifiable
        # principal — typically the user's corporate email). `extra_body` is
        # merged verbatim into the outbound JSON; `request_params` covers the
        # top-level kwarg path.
        if user_label:
            model_kwargs["request_params"] = {"user": user_label}
            model_kwargs["extra_body"] = {"user": user_label}

        friendly_model_name: str | None = None
        if model_info:
            friendly_model_name = (
                model_info.get("displayName")
                or model_info.get("name")
                or model_info.get("providerModelId")
            )

        loggable_kwargs = {k: v for k, v in model_kwargs.items() if k != "api_key"}
        logger.info(
            "[AgentFactory] Bifrost model config: model_alias=%s gateway_id=%s "
            "friendly_name=%s model_kwargs=%s",
            model_alias, llmproxy_gateway_model_id, friendly_model_name, loggable_kwargs,
        )

        llm_model = _AgnoLLM(**model_kwargs)
        logger.info(
            "[AgentFactory] Bifrost model object created: type=%s, "
            "has_temperature=%s has_top_p=%s has_max_tokens=%s",
            type(llm_model).__name__,
            hasattr(llm_model, "temperature"),
            hasattr(llm_model, "top_p"),
            hasattr(llm_model, "max_tokens"),
        )

        # Guardrails enforcement
        guardrails = config.get("guardrails") or {}
        max_iterations = guardrails.get("maxIterations", 25)
        timeout_seconds = guardrails.get("timeoutSeconds", 300)

        agent_kwargs: dict[str, Any] = {
            "model": llm_model,
            "instructions": config.get("systemPrompt", ""),
            "description": config.get("role", ""),
            "markdown": True,
            "telemetry": False,
        }

        # allowedTools filtering
        mcp_server_configs = config.get("mcpServers") or []
        if tools and mcp_server_configs:
            tools = _filter_tools_by_allowed(tools, mcp_server_configs)

        if tools:
            agent_kwargs["tools"] = tools
        if response_model:
            agent_kwargs["output_schema"] = response_model

        kb_citations: list[dict] = []
        kb_ids = config.get("knowledgeBaseIds", [])
        if kb_ids and self._kb_client:
            project_id = config.get("projectId")
            if not project_id:
                logger.warning("Agent has knowledgeBaseIds but no projectId; KB retrieval disabled")
            else:
                rag_config = config.get("ragConfig") or {}
                raw_mode = rag_config.get("searchMode", "hybrid")
                from .kb_retrieval import (
                    make_kb_retriever, SEARCH_MODE_MAP,
                    build_kb_instructions,
                )
                from .sanitize import GUARDRAIL_INSTRUCTIONS

                retriever = make_kb_retriever(
                    client=self._kb_client,
                    project_id=project_id,
                    knowledge_base_ids=kb_ids,
                    top_k=rag_config.get("topK", 10),
                    min_score=rag_config.get("similarityThreshold", 0.0),
                    search_mode=SEARCH_MODE_MAP.get(raw_mode, raw_mode),
                    citations_sink=kb_citations,
                )
                agent_kwargs["knowledge_retriever"] = retriever
                agent_kwargs["search_knowledge"] = True

                kb_metadata: list[dict] = []
                if self._http_client and self._config_service_url:
                    kb_metadata = await self._resolve_kb_metadata(
                        project_id, kb_ids,
                    )

                existing = agent_kwargs.get("instructions", "") or ""
                if kb_metadata:
                    kb_context = build_kb_instructions(kb_metadata)
                    agent_kwargs["instructions"] = (
                        f"{kb_context}\n\n{existing}" if existing else kb_context
                    )
                    kb_names = [m["name"] for m in kb_metadata]
                    logger.info(
                        "KB context injected into system prompt: kbs=%s",
                        kb_names,
                    )
                else:
                    agent_kwargs["instructions"] = (
                        f"{GUARDRAIL_INSTRUCTIONS}\n\n{existing}" if existing
                        else GUARDRAIL_INSTRUCTIONS
                    )
                    logger.info("KB guardrail instructions injected (no metadata available)")

                logger.info(
                    "Attached KB retrieval: %d KBs, mode=%s, topK=%d",
                    len(kb_ids), raw_mode, rag_config.get("topK", 10),
                )

        mcp_fragments = _collect_mcp_prompt_fragments(resolved_mcp, project_id)
        if mcp_fragments:
            mcp_context = "\n\n".join(mcp_fragments)
            existing = agent_kwargs.get("instructions", "")
            agent_kwargs["instructions"] = (
                f"{mcp_context}\n\n{existing}" if existing else mcp_context
            )
            logger.info(
                "MCP prompt fragments injected: %d fragment(s) from %d server(s)",
                len(mcp_fragments), len(resolved_mcp),
            )

        if self._shared_db is not None and not team_context:
            agent_kwargs["db"] = self._shared_db
        elif self._shared_db is None:
            logger.debug("No shared PostgresDb; sessions will not persist")

        memory_type = config.get("memoryType", "conversation")

        # History injection is owned by ContextManager (see main.py).
        # Agno suppresses its own ``add_history_to_context`` path whenever
        # input is a List[Message] (Agno _messages.py:1618), so passing
        # our pre-built message list is sufficient. We don't set
        # ``add_history_to_context`` here.
        if memory_type != "none":
            logger.info("Conversation memory enabled: type=%s", memory_type)

        elapsed = time.monotonic() - t_start

        capabilities = []
        if tools:
            capabilities.append(f"tools={len(tools)}")
        if "knowledge_retriever" in agent_kwargs:
            capabilities.append(f"kb_retrieval=True(kbs={len(kb_ids)})")
        if response_model:
            capabilities.append("output_schema=True")
        if "db" in agent_kwargs:
            capabilities.append("session_persistence=True")
        if memory_type != "none":
            capabilities.append(f"memory={memory_type}")
        cap_str = ", ".join(capabilities) if capabilities else "none"

        safe_keys = {
            k: (type(v).__name__ if k in ("model", "db", "knowledge_retriever") else v)
            for k, v in agent_kwargs.items()
            if k != "instructions"
        }
        safe_keys["instructions_len"] = len(agent_kwargs.get("instructions", "") or "")
        logger.info(
            "[AgentFactory] Final agent_kwargs (excluding instructions body): %s",
            safe_keys,
        )

        logger.info(
            "[AgentFactory] Agent created in %.3fs: agent=%s model=%s capabilities=[%s]",
            elapsed, agent_id, llmproxy_gateway_model_id, cap_str,
        )

        agent = _Agent(**agent_kwargs)
        agent._kb_citations = kb_citations
        agent._model_name = friendly_model_name or (
            model_alias.split("/", 1)[-1] if "/" in model_alias else model_alias
        )
        agent._memory_type = memory_type
        agent._loaded_mcp_server_ids = list(loaded_server_ids)
        agent._skipped_mcp_servers = skipped_mcp
        agent._timeout_seconds = timeout_seconds
        agent._max_iterations = max_iterations
        agent._has_outcome_schema = bool(config.get("outcomeSchema"))

        # Context-management attributes consumed by main.py's ContextManager.
        # See docs/design/agent-service-context-management.md.
        agent._provider = (model_info or {}).get("provider") if model_info else None
        agent._context_window = (model_info or {}).get("contextWindow") if model_info else None
        agent._model_max_output_tokens = (model_info or {}).get("maxOutputTokens") if model_info else None
        agent._supports_extended_output = bool(
            (model_info or {}).get("supportsExtendedOutput")
        ) if model_info else False
        agent._memory_config_raw = config.get("memoryConfig") or {}
        agent._agent_max_tokens = config.get("maxTokens")
        agent._has_tools = bool(tools)
        agent._instructions_text = agent_kwargs.get("instructions", "") or ""
        return agent
