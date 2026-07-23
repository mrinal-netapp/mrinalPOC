"""Agent-service team memory suite — per-session isolation.

Chained end-to-end flow against a live deployment:

    project -> model -> math agent + science agent
            -> sequential team (memory enabled)
            -> seed session 1 (Rahul) -> seed session 2 (Mohit)
            -> recall session 1 -> recall session 2

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`). Two plain member agents (math, science)
are created with a neutral short-answer system prompt and no memory of their
own; the *team* is created with `memoryType="sliding_window"` +
`memoryConfig.windowSize` (generous), so conversation memory lives at the team
level (keyed by team id) rather than on any member. The team is then invoked on
two independent, server-minted sessions: session 1 is told the user's friend is
`Rahul`, session 2 is told the friend is `Mohit`. Both sessions are seeded
before either recall runs, so asking each session to list the user's friends
proves per-session isolation of team memory — session 1 recalls only `Rahul`,
session 2 only `Mohit`, with neither leaking the other's fact. State flows
between the ordered methods through a single class-scoped `TeamIsolationContext`.

This file covers isolation only; the team sliding-window message cap lives in
the sibling ``team_history_messge_limit`` suite. Teams have no `memoryContext`
block (only `memoryType` / `memoryConfig`) and no per-team session-count cap.
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
PROJECT_NAME_PREFIX = "e2e-memory-team-iso"
PROJECT_SOURCE = "pytest-team-memory-isolation"
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
# direct so the team's recall output is easy to scan for friend names.
_MEMBER_SYSTEM_PROMPT = "Answer the user's question directly and concisely."

# Friends seeded into two independent sessions of the same memory team.
# Session 1 is told the friend is Rahul; session 2 is told Mohit.
_SESSION_1_FRIEND = "Rahul"
_SESSION_2_FRIEND = "Mohit"

# Generous team sliding-window size: isolation seeds only one fact per session,
# so the window is set well above that to guarantee the seed is always loaded on
# recall. Eviction is exercised by the sibling team history-limit suite.
_WINDOW_SIZE = 10


def _has_substring(output: str, substring: str) -> bool:
    """Return whether ``substring`` occurs in ``output``, case-insensitively.

    Used by the recall turns to check whether a friend's name is (or is not)
    present in the team output without worrying about letter casing.
    """
    return substring.lower() in (output or "").lower()


@dataclass
class TeamIsolationContext:
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
    session_id_1: str | None = None
    session_id_2: str | None = None
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestMemoryTeamIsolation:
    """Ordered team per-session isolation flow (methods run in order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> TeamIsolationContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = TeamIsolationContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: TeamIsolationContext) -> None:
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
        self, ctx: TeamIsolationContext
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

    def test_add_and_validate_model(self, ctx: TeamIsolationContext) -> None:
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

    def test_create_math_agent(self, ctx: TeamIsolationContext) -> None:
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
            name=unique_name("memory_team_iso_math"),
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

    def test_create_science_agent(self, ctx: TeamIsolationContext) -> None:
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
            name=unique_name("memory_team_iso_science"),
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

    def test_create_team_with_memory(self, ctx: TeamIsolationContext) -> None:
        """Create a sequential two-member team with sliding-window memory.

        Test scenario:
            Skips if either member agent or the model is missing. POSTs a
            ``TeamCreationRequest`` with a ``sequential`` orchestration policy,
            the two member agents, and team-level ``memoryType="sliding_window"``
            + ``memoryConfig.windowSize``, then stores the team id on context.

        Validation we are covering:
            Asserts HTTP 201, that the team id matches the ``agr-xxxxxxxx``
            pattern, that ``orchestrationPolicy`` is ``sequential`` with exactly
            two members, and that the echoed ``memoryType`` and
            ``memoryConfig.windowSize`` reflect the requested team memory
            settings.
        """
        if not (ctx.math_agent_id and ctx.science_agent_id and ctx.model_id):
            pytest.skip("prerequisites missing (member agents / model)")
        ctx.team_name = unique_name("e2e-memory-team-iso")
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

    def test_get_team_memory_configuration(self, ctx: TeamIsolationContext) -> None:
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

    def test_invoke_team_seed_friend_session_1(
        self, ctx: TeamIsolationContext
    ) -> None:
        """Seed session 1 by naming a friend on a fresh (null) session.

        Test scenario:
            Skips if no team exists. Invokes the team with ``sessionId`` unset
            (null) so the server mints a new session, states that the user's
            friend is ``Rahul``, and captures the returned session id as
            session 1 for the later recall turn.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, a present ``durationMs``, and a
            non-empty minted session id; when ``memoryDegraded`` is present it
            must be ``False``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_with_memory did not succeed")
        # sessionId is left null so agent-service mints a brand-new session; we
        # capture it as session 1 and replay it on the session-1 recall turn.
        request = AgentInvocationRequest(
            input=f"{_SESSION_1_FRIEND} is one of my friend",
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
        ctx.session_id_1 = data.get("sessionId")
        assert ctx.session_id_1, (
            "agent-service did not return a sessionId on the session-1 seed turn"
        )
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the session-1 seed turn"
            )

    def test_invoke_team_seed_friend_session_2(
        self, ctx: TeamIsolationContext
    ) -> None:
        """Seed session 2 by naming a different friend on another fresh session.

        Test scenario:
            Skips if no team exists. Invokes the same team again with
            ``sessionId`` unset (null) so the server mints a second, independent
            session, states that the user's friend is ``Mohit``, and captures
            the returned session id as session 2. Seeding both sessions before
            either recall is what lets the recall turns prove per-session
            isolation of team memory.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, a present ``durationMs``, a
            non-empty minted session id, and that it differs from session 1;
            when ``memoryDegraded`` is present it must be ``False``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_with_memory did not succeed")
        # A second null sessionId mints an independent session; we capture it as
        # session 2 and replay it on the session-2 recall turn.
        request = AgentInvocationRequest(
            input=f"{_SESSION_2_FRIEND} is one of my friend",
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
        ctx.session_id_2 = data.get("sessionId")
        assert ctx.session_id_2, (
            "agent-service did not return a sessionId on the session-2 seed turn"
        )
        assert ctx.session_id_2 != ctx.session_id_1, (
            "session 2 reused session 1's id; expected an independent session"
        )
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the session-2 seed turn"
            )

    def test_invoke_team_recall_friends_session_1(
        self, ctx: TeamIsolationContext
    ) -> None:
        """Recall friends on session 1; must surface only session 1's friend.

        Test scenario:
            Skips if the team or session 1 is missing. Replays session 1's id
            and asks the team to list all the user's friends, then inspects the
            output text.

        Validation we are covering:
            Asserts HTTP 200 and non-empty output; that ``memoryDegraded`` (if
            present) is ``False``; and — the isolation guarantee — that the
            output contains ``Rahul`` (session 1's friend, which can only come
            from loaded team memory) and does NOT contain ``Mohit`` (session 2's
            friend, seeded on a different session).
        """
        if not ctx.team_id or not ctx.session_id_1:
            pytest.skip(
                "no session 1 — test_invoke_team_seed_friend_session_1 did not succeed"
            )
        request = AgentInvocationRequest(
            input="Tell me name of all my friends I have told you",
            session_id=ctx.session_id_1,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        output = data.get("output") or ""
        assert output, "empty team output"
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the session-1 recall turn"
            )
        assert _has_substring(output, _SESSION_1_FRIEND), (
            f"session-1 recall did not surface its own friend {_SESSION_1_FRIEND!r}; "
            f"output={output!r}"
        )
        assert not _has_substring(output, _SESSION_2_FRIEND), (
            f"session-1 recall leaked session-2's friend {_SESSION_2_FRIEND!r}; "
            f"team memory is not session-isolated. output={output!r}"
        )

    def test_invoke_team_recall_friends_session_2(
        self, ctx: TeamIsolationContext
    ) -> None:
        """Recall friends on session 2; must surface only session 2's friend.

        Test scenario:
            Skips if the team or session 2 is missing. Replays session 2's id
            and asks the same question, then inspects the output text. This is
            the mirror of the session-1 recall and completes the isolation proof.

        Validation we are covering:
            Asserts HTTP 200 and non-empty output; that ``memoryDegraded`` (if
            present) is ``False``; and — the isolation guarantee — that the
            output contains ``Mohit`` (session 2's friend) and does NOT contain
            ``Rahul`` (session 1's friend, seeded on a different session).
        """
        if not ctx.team_id or not ctx.session_id_2:
            pytest.skip(
                "no session 2 — test_invoke_team_seed_friend_session_2 did not succeed"
            )
        request = AgentInvocationRequest(
            input="Tell me name of all my friends I have told you",
            session_id=ctx.session_id_2,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        output = data.get("output") or ""
        assert output, "empty team output"
        if "memoryDegraded" in data:
            assert data["memoryDegraded"] is False, (
                "team memory degraded on the session-2 recall turn"
            )
        assert _has_substring(output, _SESSION_2_FRIEND), (
            f"session-2 recall did not surface its own friend {_SESSION_2_FRIEND!r}; "
            f"output={output!r}"
        )
        assert not _has_substring(output, _SESSION_1_FRIEND), (
            f"session-2 recall leaked session-1's friend {_SESSION_1_FRIEND!r}; "
            f"team memory is not session-isolated. output={output!r}"
        )
