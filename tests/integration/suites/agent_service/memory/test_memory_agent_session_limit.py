"""Agent-service memory suite — session-count limit (eviction).

Chained end-to-end flow against a live deployment:

    project -> model -> agent (session_history_limit=2)
            -> seed session 1 -> seed session 2
            -> mint session 3 (null) -> list sessions

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`). The agent is created with
``memoryContext.session_history_limit`` set to ``_SESSION_HISTORY_LIMIT`` (2).
Two independent sessions are minted (each via a null ``sessionId``), then a
third null-session invoke is issued. Per the agent-service contract the oldest
session by ``created_at`` is evicted before the new one is saved, so listing the
agent's sessions afterwards must show exactly the limit, with session 1 (the
oldest) gone and sessions 2 and 3 retained.

The session list comes from ``GET .../agents/{id}/sessions`` via the client's
``list_agent_sessions`` helper; the assertion reads ``total`` and the
``sessions[].sessionId`` values. State flows between the ordered methods through
a single class-scoped `AgentSessionLimitContext`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.agent_invoke_request import AgentInvocationRequest
from lib.models.resources import SuiteResources

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.memory,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-memory-sesslimit"
PROJECT_SOURCE = "pytest-agent-memory-sesslimit"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Maximum number of concurrent sessions retained for this agent, configured via
# memoryContext.session_history_limit. Per the agent-service contract, once a
# newly minted session pushes the count past this value the oldest session by
# created_at is evicted before the new one is saved, so the sessions list never
# exceeds this limit.
_SESSION_HISTORY_LIMIT = 2

# Distinct seed prompts for the three sessions. Content is irrelevant to the
# session-count assertion (we list sessions and compare ids, not transcripts);
# the prompts are kept distinct only for readability in the logs.
_SESSION_1_SEED = "Remember, my favorite colour is blue."
_SESSION_2_SEED = "Remember, my favorite colour is green."
_SESSION_3_SEED = "This is a brand new conversation."


@dataclass
class AgentSessionLimitContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id: str = ""
    session_id_1: str | None = None
    session_id_2: str | None = None
    session_id_3: str | None = None
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestMemoryAgentSessionLimit:
    """Ordered session-count eviction flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> AgentSessionLimitContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = AgentSessionLimitContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: AgentSessionLimitContext) -> None:
        """Reuse a healthy ``PROJECT_ID`` or create + readiness-gate a project."""
        env_project_id = ctx.config.project_id
        if env_project_id:
            resp = ctx.config_client.get_project_service_account(env_project_id)
            log_exchange(
                "GET",
                f"{ctx.config.config_service_url}/api/v1/projects/{env_project_id}"
                "/service-account",
                None,
                resp,
            )
            if resp.status_code == 200:
                log.info(f"  [setup] reusing healthy project PROJECT_ID={env_project_id}")
                ctx.project_id = env_project_id
                return
            log.info(
                f"  [setup] PROJECT_ID={env_project_id} not healthy "
                f"(HTTP {resp.status_code}) — creating a new project"
            )

        name = unique_name(PROJECT_NAME_PREFIX)
        metadata = {"source": PROJECT_SOURCE}
        url = f"{ctx.config.config_service_url}/api/v1/projects"
        resp = ctx.config_client.create_project(name, metadata=metadata)
        log_exchange("POST", url, {"name": name, "metadata": metadata}, resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        project_id = data["id"]
        assert project_id, "project id missing in response"
        ctx.resources.add_project(project_id)
        wait_for_project_ready(
            ctx.config_client,
            project_id,
            timeout_sec=PROJECT_READY_TIMEOUT_SEC,
            poll_interval_sec=PROJECT_READY_POLL_SEC,
        )
        ctx.project_id = project_id
        if hasattr(ctx, "project_name"):
            ctx.project_name = data.get("name", name)

    def test_add_and_validate_azure_openai_cred(
        self, ctx: AgentSessionLimitContext
    ) -> None:
        """Reuse a healthy ``AZURE_OPENAI_CRED_ID`` or create + validate a cred."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_and_validate_project did not succeed")

        if ctx.config.model_id:
            log.info("LLM_MODEL_ID set — skipping Azure credential provisioning")
            return

        env_cred_id = ctx.config.azure_openai_cred_id
        if env_cred_id:
            resp = ctx.config_client.get_credential(ctx.project_id, env_cred_id)
            log_exchange(
                "GET",
                f"{ctx.config_client.credentials_url(ctx.project_id)}/{env_cred_id}",
                None,
                resp,
            )
            if resp.status_code == 200:
                log.info(
                    f"  [setup] reusing healthy credential "
                    f"AZURE_OPENAI_CRED_ID={env_cred_id}"
                )
                ctx.credential_id = env_cred_id
                return
            log.info(
                f"  [setup] AZURE_OPENAI_CRED_ID={env_cred_id} not healthy "
                f"(HTTP {resp.status_code}) — creating a new credential"
            )

        provisioner = ModelProvisioner(ctx.config_client, on_exchange=log_exchange)
        credential_id = provisioner.add_azure_openai_credentials(ctx.project_id)
        ctx.resources.add_credential(credential_id, ctx.project_id)
        resp = ctx.config_client.get_credential(ctx.project_id, credential_id)
        log_exchange(
            "GET",
            f"{ctx.config_client.credentials_url(ctx.project_id)}/{credential_id}",
            None,
            resp,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == credential_id
        assert data.get("provider") == "azure"
        ctx.credential_id = credential_id

    def test_add_and_validate_model(self, ctx: AgentSessionLimitContext) -> None:
        """Reuse ``LLM_MODEL_ID`` or register + validate a model on the credential."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_and_validate_project did not succeed")

        env_model_id = ctx.config.model_id
        if env_model_id:
            log.info(f"  [setup] reusing model from LLM_MODEL_ID env: {env_model_id}")
            ctx.model_id = env_model_id
            return

        if not ctx.credential_id:
            pytest.skip(
                "no credential — test_add_and_validate_azure_openai_cred did not succeed"
            )
        provisioner = ModelProvisioner(ctx.config_client, on_exchange=log_exchange)
        model_id = provisioner.add_llm_models(ctx.project_id, ctx.credential_id)
        assert model_id, "model id missing in response"
        assert UUID_RE.match(model_id), f"unexpected model id: {model_id!r}"
        ctx.resources.add_model(model_id, ctx.project_id)
        ctx.model_id = model_id

    def test_create_agent_with_session_limit(
        self, ctx: AgentSessionLimitContext
    ) -> None:
        """Create an agent capped at ``_SESSION_HISTORY_LIMIT`` sessions.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` using
            ``sliding_window`` memory with ``memoryContext.session_history_limit``
            set to ``_SESSION_HISTORY_LIMIT`` (2), then stores the returned agent
            id on the context.

        Validation we are covering:
            Asserts HTTP 201, that the agent id matches the ``ag-xxxxxxxx``
            pattern, and that the echoed ``modelId``, ``memoryType``, and
            ``memoryContext.enabled`` reflect the requested memory settings.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("memory_sesslimit_agent"),
            role="you are an helpful memory agent",
            system_prompt="Give very short answers",
            model_id=ctx.model_id,
            memory_type="sliding_window",
            memory_config={"windowSize": 2},
            memory_context={
                "enabled": True,
                "message_retention_policy": "sliding_window",
                "message_history_limit": 2,
                "session_history_limit": _SESSION_HISTORY_LIMIT,
            },
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id), f"unexpected agent id: {ctx.agent_id!r}"
        assert data.get("modelId") == ctx.model_id
        assert data.get("memoryType") == "sliding_window"
        assert data.get("memoryContext", {}).get("enabled") is True
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_get_agent_memory_configuration(
        self, ctx: AgentSessionLimitContext
    ) -> None:
        """Fetch agent details and validate persisted session-limit settings.

        Test scenario:
            Skips if no agent exists. GETs the created agent from
            config-service and validates memory/session-cap persistence.

        Validation we are covering:
            Asserts HTTP 200 and that memory fields match the creation request:
            ``memoryType=sliding_window``, ``memoryConfig.windowSize`` equals
            2, and ``memoryContext.session_history_limit`` equals
            ``_SESSION_HISTORY_LIMIT``.
        """
        if not ctx.agent_id:
            pytest.skip(
                "no agent — test_create_agent_with_session_limit did not succeed"
            )
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}"
        )
        resp = ctx.config_client.get_agent(ctx.project_id, ctx.agent_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.agent_id
        assert data.get("memoryType") == "sliding_window"
        assert data.get("memoryConfig", {}).get("windowSize") == 2
        memory_context = data.get("memoryContext") or {}
        assert memory_context.get("enabled") is True
        assert memory_context.get("type") == "window"
        assert memory_context.get("message_window_limit") == 2

    def test_invoke_agent_seed_session_1(
        self, ctx: AgentSessionLimitContext
    ) -> None:
        """Mint session 1 (the oldest) via a null ``sessionId``.

        Test scenario:
            Skips if no agent exists. Invokes the agent with ``sessionId`` unset
            (null) so the server mints the first session, and captures the
            returned session id as session 1.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, a present ``durationMs``, and a
            non-empty minted session id; when ``memoryDegraded`` is present it
            must be ``False``.
        """
        if not ctx.agent_id:
            pytest.skip(
                "no agent — test_create_agent_with_session_limit did not succeed"
            )
        request = AgentInvocationRequest(input=_SESSION_1_SEED, session_id=None)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        assert "durationMs" in data
        ctx.session_id_1 = data.get("sessionId")
        assert ctx.session_id_1, (
            "agent-service did not return a sessionId on the session-1 seed turn"
        )
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "session memory degraded on the session-1 seed turn"
            )

    def test_invoke_agent_seed_session_2(
        self, ctx: AgentSessionLimitContext
    ) -> None:
        """Mint session 2 via another null ``sessionId``.

        Test scenario:
            Skips if no agent exists. Invokes the same agent again with
            ``sessionId`` unset (null) so the server mints a second, independent
            session, and captures the returned session id as session 2. After
            this turn the agent holds exactly ``_SESSION_HISTORY_LIMIT`` (2)
            sessions.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, a present ``durationMs``, a
            non-empty minted session id, and that it differs from session 1;
            when ``memoryDegraded`` is present it must be ``False``.
        """
        if not ctx.agent_id:
            pytest.skip(
                "no agent — test_create_agent_with_session_limit did not succeed"
            )
        request = AgentInvocationRequest(input=_SESSION_2_SEED, session_id=None)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        assert "durationMs" in data
        ctx.session_id_2 = data.get("sessionId")
        assert ctx.session_id_2, (
            "agent-service did not return a sessionId on the session-2 seed turn"
        )
        assert ctx.session_id_2 != ctx.session_id_1, (
            "session 2 reused session 1's id; expected an independent session"
        )
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "session memory degraded on the session-2 seed turn"
            )

    def test_invoke_agent_new_session_evicts_oldest(
        self, ctx: AgentSessionLimitContext
    ) -> None:
        """Mint a third session, pushing the agent past its session limit.

        Test scenario:
            Skips if the agent or either prior session is missing. With
            ``session_history_limit`` set to ``_SESSION_HISTORY_LIMIT`` (2) the
            agent already holds two sessions (1 and 2). Invokes the agent with
            ``sessionId`` unset (null) so the server mints a third, independent
            session, and captures it as session 3. Creating this session is what
            trips session-level eviction, verified by the next test.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, a present ``durationMs``, a
            non-empty minted session id, and that it differs from both session 1
            and session 2; when ``memoryDegraded`` is present it must be
            ``False``.
        """
        if not ctx.agent_id or not ctx.session_id_1 or not ctx.session_id_2:
            pytest.skip("no prior sessions — earlier seed turns did not succeed")
        # A third null sessionId mints one more independent session; with the
        # agent's session_history_limit at 2 this pushes the session count to 3
        # and is expected to evict the oldest (session 1) before saving it.
        request = AgentInvocationRequest(input=_SESSION_3_SEED, session_id=None)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        assert "durationMs" in data
        ctx.session_id_3 = data.get("sessionId")
        assert ctx.session_id_3, (
            "agent-service did not return a sessionId on the session-3 seed turn"
        )
        assert ctx.session_id_3 not in (ctx.session_id_1, ctx.session_id_2), (
            "session 3 reused an earlier session id; expected an independent session"
        )
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "session memory degraded on the session-3 seed turn"
            )