"""Agent-service team memory suite — sliding-window message-history limit.

Chained end-to-end flow against a live deployment:

    project -> model -> math agent + science agent
            -> sequential team (sliding_window, windowSize=4)
            -> seed friend 1 (Rahul) -> seed friend 2 (Aniket)
            -> seed friend 3 (Ajay)  -> recall after eviction

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`). Two plain member agents (math, science)
are created with a neutral short-answer system prompt and no memory of their
own; the *team* is created with `memoryType="sliding_window"` +
`memoryConfig.windowSize`, so conversation memory lives at the team level. A
single session is seeded with three friends in order, accumulating six stored
messages (three user/assistant exchanges). With ``memoryConfig.windowSize`` set
to ``_WINDOW_SIZE`` (4), the contract is that
``citations.contextUsed.historyMessagesCount`` caps at the window once the
session holds more messages than it — the oldest exchange slides out. The final
recall asserts that server-reported integer equals the window.

We assert on ``historyMessagesCount`` rather than the model's prose because the
team echoes prior messages cumulatively, which would defeat any content-based
eviction check. Teams have no `memoryContext` block (only `memoryType` /
`memoryConfig`); the team path enforces the window. State flows between the
ordered methods through a single class-scoped `TeamHistoryLimitContext`.
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
from lib.models.team_creation_request import TeamCreationRequest, TeamMemberRef

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.memory,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-memory-team-msglimit"
PROJECT_SOURCE = "pytest-team-memory-msglimit"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
TEAM_ID_RE = re.compile(r"^agr-[a-z0-9]{8}$")

# Sequential orchestration runs the two member agents in order with no manager;
# conversation memory is provided by the team, not the members.
TEAM_POLICY = "sequential"

# Neutral, topic-agnostic prompt for both member agents: keep answers short and
# direct so the team's recall output is easy to scan.
_MEMBER_SYSTEM_PROMPT = "Answer the user's question directly and concisely."

# Three friends seeded in order into a single session. Each seed is one
# user/assistant exchange (two stored messages); three seeds = six stored
# messages, above the four-message window so eviction must occur.
_FRIEND_1 = "Rahul"
_FRIEND_2 = "Aniket"
_FRIEND_3 = "Ajay"

# Window size (in messages) configured on the team via memoryConfig.windowSize.
# Teams have no memoryContext block, so windowSize is the only knob; the
# contract is that citations.contextUsed.historyMessagesCount equals this value
# once the session holds more messages than the window.
_WINDOW_SIZE = 4


@dataclass
class TeamHistoryLimitContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    math_agent_id: str = ""
    science_agent_id: str = ""
    team_id: str = ""
    team_name: str = ""
    session_id: str | None = None
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestMemoryTeamHistoryMessageLimit:
    """Ordered team sliding-window message-cap flow (methods run in order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> TeamHistoryLimitContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = TeamHistoryLimitContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: TeamHistoryLimitContext) -> None:
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
        self, ctx: TeamHistoryLimitContext
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

    def test_add_and_validate_model(self, ctx: TeamHistoryLimitContext) -> None:
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

    def test_create_math_agent(self, ctx: TeamHistoryLimitContext) -> None:
        """Create the first plain member agent (no per-agent memory).

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` (role
            ``math``, neutral short-answer system prompt, no memory fields) and
            stores the returned agent id on the context as the math member.

        Validation we are covering:
            Asserts HTTP 201, that the agent id matches the ``ag-xxxxxxxx``
            pattern, and that the echoed ``modelId`` and ``role`` match what was
            requested.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("memory_team_msglimit_math"),
            role="math",
            system_prompt=_MEMBER_SYSTEM_PROMPT,
            model_id=ctx.model_id,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.math_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.math_agent_id), (
            f"unexpected agent id: {ctx.math_agent_id!r}"
        )
        assert data.get("modelId") == ctx.model_id
        assert data.get("role") == "math"
        ctx.resources.add_agent(ctx.math_agent_id, ctx.project_id)

    def test_create_science_agent(self, ctx: TeamHistoryLimitContext) -> None:
        """Create the second plain member agent (no per-agent memory).

        Test scenario:
            Skips if no model exists. POSTs a second ``AgentCreationRequest``
            (role ``science``, same neutral short-answer system prompt, no
            memory fields) and stores the returned agent id on the context as
            the science member.

        Validation we are covering:
            Asserts HTTP 201, that the agent id matches the ``ag-xxxxxxxx``
            pattern, and that the echoed ``modelId`` and ``role`` match what was
            requested.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("memory_team_msglimit_science"),
            role="science",
            system_prompt=_MEMBER_SYSTEM_PROMPT,
            model_id=ctx.model_id,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.science_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.science_agent_id), (
            f"unexpected agent id: {ctx.science_agent_id!r}"
        )
        assert data.get("modelId") == ctx.model_id
        assert data.get("role") == "science"
        ctx.resources.add_agent(ctx.science_agent_id, ctx.project_id)

    def test_create_team_with_memory(self, ctx: TeamHistoryLimitContext) -> None:
        """Create a sequential two-member team with sliding-window memory.

        Test scenario:
            Skips if either member agent or the model is missing. POSTs a
            ``TeamCreationRequest`` with a ``sequential`` orchestration policy,
            the two member agents, and team-level ``memoryType="sliding_window"``
            + ``memoryConfig.windowSize`` (``_WINDOW_SIZE`` = 4), then stores the
            team id on context.

        Validation we are covering:
            Asserts HTTP 201, that the team id matches the ``agr-xxxxxxxx``
            pattern, that ``orchestrationPolicy`` is ``sequential`` with exactly
            two members, and that the echoed ``memoryType`` and
            ``memoryConfig.windowSize`` reflect the requested team memory
            settings.
        """
        if not (ctx.math_agent_id and ctx.science_agent_id and ctx.model_id):
            pytest.skip("prerequisites missing (member agents / model)")
        ctx.team_name = unique_name("e2e-memory-team-msglimit")
        request = TeamCreationRequest(
            name=ctx.team_name,
            orchestration_policy=TEAM_POLICY,
            members=[
                TeamMemberRef.agent(ctx.math_agent_id),
                TeamMemberRef.agent(ctx.science_agent_id),
            ],
            memory_type="sliding_window",
            memory_config={"windowSize": _WINDOW_SIZE},
        )
        url = ctx.config_client.agent_teams_url(ctx.project_id)
        resp = ctx.config_client.create_team(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.team_id = data["id"]
        assert TEAM_ID_RE.match(ctx.team_id), f"unexpected team id: {ctx.team_id!r}"
        assert data.get("orchestrationPolicy") == TEAM_POLICY
        assert len(data.get("members", [])) == 2
        assert data.get("memoryType") == "sliding_window"
        assert data.get("memoryConfig", {}).get("windowSize") == _WINDOW_SIZE
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    def test_get_team_memory_configuration(self, ctx: TeamHistoryLimitContext) -> None:
        """Fetch team details and validate persisted team memory settings.

        Test scenario:
            Skips if no team exists. GETs the created team from config-service
            and validates team-level memory persistence.

        Validation we are covering:
            Asserts HTTP 200 and that orchestration + memory fields match the
            create request: sequential policy, two members,
            ``memoryType=sliding_window``, and ``memoryConfig.windowSize``
            equals ``_WINDOW_SIZE``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_with_memory did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}"
        )
        resp = ctx.config_client.get_team(ctx.project_id, ctx.team_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.team_id
        assert data.get("orchestrationPolicy") == TEAM_POLICY
        assert len(data.get("members") or []) == 2
        assert data.get("memoryType") == "sliding_window"
        assert data.get("memoryConfig", {}).get("windowSize") == _WINDOW_SIZE

    def test_invoke_team_seed_friend_1(self, ctx: TeamHistoryLimitContext) -> None:
        """Seed the first friend (Rahul) on a fresh (null) session.

        Test scenario:
            Skips if no team exists. Invokes the team with ``sessionId`` unset
            (null) so the server mints a new session, states that ``Rahul`` is a
            friend, and captures the returned session id for the later seeds and
            recall.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, a present ``durationMs``, and a
            non-empty minted session id; when ``memoryDegraded`` is present it
            must be ``False``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_with_memory did not succeed")
        # sessionId is left null so agent-service mints the session we then reuse
        # for every subsequent seed and the eviction recall.
        request = AgentInvocationRequest(
            input=f"{_FRIEND_1} is one of my friend",
            session_id=None,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        assert "durationMs" in data
        ctx.session_id = data.get("sessionId")
        assert ctx.session_id, (
            "agent-service did not return a sessionId on the first seed turn"
        )
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the first seed turn"
            )

    def test_invoke_team_seed_friend_2(self, ctx: TeamHistoryLimitContext) -> None:
        """Seed a second friend (Aniket) into the same session.

        Test scenario:
            Skips if the session is missing. Replays the session id (so this
            appends to the same conversation that already knows ``Rahul``) and
            states that ``Aniket`` is a friend.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, and that ``memoryDegraded`` (if
            present) is ``False``.
        """
        if not ctx.team_id or not ctx.session_id:
            pytest.skip("no session — test_invoke_team_seed_friend_1 did not succeed")
        request = AgentInvocationRequest(
            input=f"{_FRIEND_2} is one of my friend",
            session_id=ctx.session_id,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the Aniket seed turn"
            )

    def test_invoke_team_seed_friend_3(self, ctx: TeamHistoryLimitContext) -> None:
        """Seed a third friend (Ajay) into the same session.

        Test scenario:
            Skips if the session is missing. Replays the session id and states
            that ``Ajay`` is a friend. With the configured window the session now
            retains only the most recent exchanges; the original ``Rahul``
            exchange is expected to have slid out.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, and that ``memoryDegraded`` (if
            present) is ``False``.
        """
        if not ctx.team_id or not ctx.session_id:
            pytest.skip("no session — test_invoke_team_seed_friend_1 did not succeed")
        request = AgentInvocationRequest(
            input=f"{_FRIEND_3} is one of my friend",
            session_id=ctx.session_id,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the Ajay seed turn"
            )

    def test_invoke_team_recall_after_eviction(
        self, ctx: TeamHistoryLimitContext
    ) -> None:
        """Sliding window caps loaded team history at the configured limit.

        Test scenario:
            Skips if the session is missing. By this point the session holds
            three friend seeds = six stored messages. Replays the session id and
            asks the team what messages it has received, then reads the
            server-reported ``citations.contextUsed.historyMessagesCount``.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, and — the sliding-window
            guarantee — that ``historyMessagesCount`` is present and equals
            ``_WINDOW_SIZE`` (the configured ``memoryConfig.windowSize``). We
            assert on this server-reported integer rather than the model's prose
            because the team echoes prior messages cumulatively, which would
            defeat any content-based eviction check. The team path enforces the
            window: with six stored messages and ``windowSize=4`` the loaded
            history caps at four, so the oldest (Rahul) exchange has slid out.
        """
        if not ctx.team_id or not ctx.session_id:
            pytest.skip("no session — test_invoke_team_seed_friend_1 did not succeed")
        request = AgentInvocationRequest(
            input="What are the messages I have sent you ?",
            session_id=ctx.session_id,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the eviction recall turn"
            )
        # Deterministic eviction proof: by this turn the session holds six stored
        # messages, but with memoryConfig.windowSize=4 the sliding window caps
        # the loaded history at _WINDOW_SIZE (the oldest exchange slid out).
        context_used = (data.get("citations") or {}).get("contextUsed") or {}
        history_count = context_used.get("historyMessagesCount")
        assert history_count is not None, (
            f"missing historyMessagesCount; contextUsed={context_used!r}"
        )
        assert history_count == _WINDOW_SIZE, (
            f"team sliding window not enforced: historyMessagesCount={history_count} "
            f"does not equal the configured window of {_WINDOW_SIZE}; "
            f"contextUsed={context_used!r}"
        )
