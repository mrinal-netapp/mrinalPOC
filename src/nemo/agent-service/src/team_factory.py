"""Convert AgentTeam config to Agno Team instance.

Heavy agno imports are deferred to avoid blocking startup.
"""

from typing import Any, TYPE_CHECKING

from observability_client_runtime import get_logger

from .agent_factory import AgentFactory
from .config_cache import AgentConfigCache
from .config import settings

if TYPE_CHECKING:
    from agno.team.team import Team

logger = get_logger()

_AgnoLLM = None  # Reference to ``agno.models.litellm.LiteLLM`` (upstream SDK class).

ORCHESTRATION_MAP = {
    "coordinate": "coordinate",
    "route": "route",
    "collaborate": "collaborate",
}


class TeamFactory:
    def __init__(self, agent_factory: AgentFactory, config_cache: AgentConfigCache):
        self._agent_factory = agent_factory
        self._config_cache = config_cache

    async def create_from_config(
        self,
        team_config: dict,
        project_id: str,
        visited: set[str] | None = None,
        user_label: str | None = None,
    ) -> "Team":
        from agno.team.team import Team

        team_id = team_config.get("id")
        if visited is None:
            visited = set()
        if team_id:
            if team_id in visited:
                raise ValueError(f"Team recursion cycle detected at {team_id}")
            visited = set(visited)
            visited.add(team_id)

        members = []
        for member in team_config.get("members", []):
            member_type = member.get("memberType", "agent")
            member_id = member.get("memberId") or member.get("agentId")
            if not member_id:
                continue
            if member_type == "team":
                subteam_config = await self._config_cache.get_team(project_id, member_id)
                subteam = await self.create_from_config(
                    subteam_config, project_id, visited, user_label=user_label,
                )
                members.append(subteam)
                continue

            agent_config = await self._config_cache.get(project_id, member_id)
            agent = await self._agent_factory.create_from_config(
                agent_config, team_context=True, user_label=user_label,
            )
            if member.get("role"):
                agent.description = member["role"]
            members.append(agent)

        mode = ORCHESTRATION_MAP.get(
            team_config.get("orchestrationPolicy", team_config.get("orchestration", "coordinate")),
            "coordinate",
        )

        team_kwargs: dict[str, Any] = {
            "name": team_config.get("name", "team"),
            "mode": mode,
            "members": members,
        }

        manager = team_config.get("manager") or {}
        manager_model_id = manager.get("modelId") or None
        manager_model_class = manager.get("modelClass") or None

        effective_model_name: str | None = None
        manager_model_info: dict | None = None

        resolver = self._agent_factory.model_resolver
        if manager_model_id or manager_model_class:
            global _AgnoLLM
            if _AgnoLLM is None:
                from agno.models.litellm import LiteLLM as _L
                _AgnoLLM = _L

            effective_id, model_info = await resolver.resolve_effective_model(
                project_id, manager_model_id, manager_model_class,
            )
            manager_model_info = model_info

            model_alias = effective_id
            from .llmproxy_gateway_settings import (
                llmproxy_gateway_api_key_for_model,
                llmproxy_gateway_chat_completions_base,
                llmproxy_gateway_model_id_with_sdk_prefix,
                resolve_llmproxy_gateway_model_id,
            )

            llmproxy_gateway_model_id = resolve_llmproxy_gateway_model_id(model_alias, model_info)
            model_kwargs: dict[str, Any] = {
                # `llmproxy_gateway_model_id` is the Bifrost-ready id baked
                # at registration time (`<bifrost-provider>/<model>`). We
                # only wrap it with `openai/` so the LiteLLM SDK dispatches
                # via its OpenAI provider plugin; that prefix is stripped
                # before the request reaches Bifrost.
                "id": llmproxy_gateway_model_id_with_sdk_prefix(llmproxy_gateway_model_id, model_info),
                "api_base": llmproxy_gateway_chat_completions_base(),
                # Per-project Bifrost virtual-key bearer token. The helper
                # reads it from model_info.gatewayApiKey (populated by
                # config-service GET /models/:id from the K8s Secret
                # `as-proj-<projectId>-vk`). MissingProjectVirtualKeyError
                # bubbles up as a team-build failure if the Secret is
                # missing - intentional so operators know to retry init.
                "api_key": llmproxy_gateway_api_key_for_model(model_info),
            }
            manager_temperature = manager.get("temperature")
            manager_top_p = manager.get("topP") or manager.get("top_p")
            # Same as AgentFactory: Agno's LiteLLM class defaults temperature+top_p;
            # Vertex Claude rejects both.
            if manager_temperature is not None and manager_top_p is not None:
                logger.warning(
                    "[TeamFactory] Both manager temperature and top_p configured for team=%s; "
                    "using temperature=%s and dropping top_p=%s",
                    team_id, manager_temperature, manager_top_p,
                )
                model_kwargs["temperature"] = manager_temperature
                model_kwargs["top_p"] = None
            elif manager_temperature is not None:
                model_kwargs["temperature"] = manager_temperature
                model_kwargs["top_p"] = None
            elif manager_top_p is not None:
                model_kwargs["temperature"] = None
                model_kwargs["top_p"] = manager_top_p
            else:
                model_kwargs["temperature"] = 0.7
                model_kwargs["top_p"] = None
            if manager.get("maxTokens") is not None:
                model_kwargs["max_tokens"] = manager["maxTokens"]

            # Mirror AgentFactory: surface a `user` (corporate email or
            # fallback UUID) on both the top-level kwarg and the JSON body
            # so the upstream gateway's user-validation guard accepts it.
            if user_label:
                model_kwargs["request_params"] = {"user": user_label}
                model_kwargs["extra_body"] = {"user": user_label}

            team_kwargs["model"] = _AgnoLLM(**model_kwargs)

            if model_info:
                effective_model_name = (
                    model_info.get("displayName")
                    or model_info.get("name")
                    or model_info.get("providerModelId")
                )
            else:
                effective_model_name = (
                    model_alias.split("/", 1)[-1] if "/" in model_alias else model_alias
                )

            logger.info(
                "[TeamFactory] Manager model configured: effective_id=%s llmproxy_gateway_id=%s friendly=%s",
                effective_id, llmproxy_gateway_model_id, effective_model_name,
            )
        else:
            logger.warning(
                "[TeamFactory] No manager.modelId or modelClass in team config %s; "
                "Agno will use its default model (requires OPENAI_API_KEY)",
                team_id,
            )

        if manager.get("systemPrompt"):
            team_kwargs["instructions"] = [manager["systemPrompt"]]
        if manager.get("role"):
            team_kwargs["description"] = manager["role"]

        team = Team(**team_kwargs)
        team._model_name = effective_model_name

        # Phase 1 context-management attributes — mirror AgentFactory.
        # Teams use shared memory keyed by team_id (verified in design doc §V).
        # Without these, ContextManager would short-circuit to memory_type=none.
        team._provider = (manager_model_info or {}).get("provider")
        team._context_window = (manager_model_info or {}).get("contextWindow")
        team._model_max_output_tokens = (manager_model_info or {}).get("maxOutputTokens")
        team._supports_extended_output = bool(
            (manager_model_info or {}).get("supportsExtendedOutput")
        )
        team._memory_type = team_config.get("memoryType", "conversation")
        team._memory_config_raw = team_config.get("memoryConfig") or {}
        team._agent_max_tokens = manager.get("maxTokens")
        team._has_outcome_schema = False
        # Manager system prompt is the "instructions" text for budgeting.
        team._instructions_text = manager.get("systemPrompt", "") or ""
        # Teams aggregate tools across members; a conservative bool keeps
        # the tool-round reservation active if ANY member has tools.
        # Detecting this precisely requires walking members which is heavier
        # than necessary. Default true if there are any agent members.
        team._has_tools = any(
            m.get("memberType", "agent") == "agent"
            for m in team_config.get("members", [])
        )
        team._loaded_mcp_server_ids = []
        return team
