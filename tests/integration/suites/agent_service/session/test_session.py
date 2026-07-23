"""Agent-service session suite.

Chained end-to-end flow against a live deployment:

    project -> model -> agent -> invoke (creates session)
            -> list -> get transcript -> rename -> isolation -> delete -> 404

Provisioning uses config-service (`ConfigServiceClient`); invokes and session
management use agent-service (`AgentServiceClient`). The agent is created with
memory enabled so the session store reliably persists transcripts. The client
supplies its own raw `sessionId` on invoke (the server is session-less
otherwise); list/detail echo that raw id. State flows between the ordered
methods through a single class-scoped `SessionContext`.
"""

from __future__ import annotations

import json
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
    pytest.mark.session,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-session"
PROJECT_SOURCE = "pytest-agent-session"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
# Server mints a session id with ``uuid.uuid4().hex`` (32 lowercase hex chars)
# when the caller does not supply one.
MINTED_SESSION_RE = re.compile(r"^[0-9a-f]{32}$")

_USER_NAME = "Prince"


@dataclass
class SessionContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id: str = ""
    session_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestSession:
    """Ordered session lifecycle flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> SessionContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = SessionContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: SessionContext) -> None:
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
        self, ctx: SessionContext
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

    def test_add_and_validate_model(self, ctx: SessionContext) -> None:
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

    def test_create_agent(self, ctx: SessionContext) -> None:
        """Create a memory-enabled agent so sessions persist transcripts.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` with
            ``sliding_window`` memory and a memory context enabling retention,
            then stores the returned agent id on the context.

        Validation we are covering:
            Asserts HTTP 201 and that the returned agent id matches the
            ``ag-xxxxxxxx`` pattern.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("session_agent"),
            role="you are an helpful session agent",
            system_prompt="Give very short answers",
            model_id=ctx.model_id,
            memory_type="sliding_window",
            memory_config={"windowSize": 20},
            memory_context={
                "enabled": True,
                "message_retention_policy": "sliding_window",
                "message_history_limit": 20,
                "session_history_limit": 10,
            },
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id), f"unexpected agent id: {ctx.agent_id!r}"
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_invoke_without_session_id_mints_one(self, ctx: SessionContext) -> None:
        """Invoke with no session id and confirm the server mints a fresh one.

        Test scenario:
            Skips if no agent exists. Invokes the agent twice without supplying
            a ``sessionId`` so the server mints one each turn, capturing both
            returned ids.

        Validation we are covering:
            Asserts HTTP 200 and non-empty output on the first turn, that each
            minted id matches the uuid4-hex pattern, and that the second minted
            id differs from the first (proving a fresh id per turn).
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )

        # Invoke with no sessionId in the body: the server should mint one.
        request = AgentInvocationRequest(input="Hello, who are you?")
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        minted_id = data.get("sessionId")
        assert minted_id, "server did not return a sessionId when none was supplied"
        assert MINTED_SESSION_RE.match(minted_id), (
            f"minted sessionId is not a uuid4 hex: {minted_id!r}"
        )

        # A second no-sessionId invoke must mint a *different* id, proving the
        # server generates a fresh unique session per turn (not a fixed value).
        request2 = AgentInvocationRequest(input="Hello again.")
        resp2 = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request2)
        log_exchange("POST", url, request2.to_body(), resp2)
        assert resp2.status_code == 200, resp2.text
        data2 = resp2.json()
        minted_id_2 = data2.get("sessionId")
        assert minted_id_2 and MINTED_SESSION_RE.match(minted_id_2), (
            f"second minted sessionId is not a uuid4 hex: {minted_id_2!r}"
        )
        assert minted_id_2 != minted_id, (
            "server reused the same minted sessionId across two session-less "
            f"invokes: {minted_id!r}"
        )

    def test_invoke_creates_session(self, ctx: SessionContext) -> None:
        """Invoke with a caller-supplied session id, seeding the user's name.

        Test scenario:
            Skips if no agent exists. Generates a unique raw ``sessionId``,
            stores it on the context, and invokes the agent with an input that
            states the user's name under that session.

        Validation we are covering:
            Asserts HTTP 200 and that the response ``output`` is non-empty.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        ctx.session_id = unique_name("session-id")
        request = AgentInvocationRequest(
            input=f"My name is {_USER_NAME}",
            session_id=ctx.session_id,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"

    def test_list_sessions(self, ctx: SessionContext) -> None:
        """List the agent's sessions and confirm the created one appears.

        Test scenario:
            Skips if no session was created. GETs the agent sessions listing and
            extracts the ``sessionId`` of each returned session.

        Validation we are covering:
            Asserts HTTP 200, that the created session id is present in the
            listing, and that the reported ``total`` is at least one.
        """
        if not ctx.session_id:
            pytest.skip("no session — test_invoke_creates_session did not succeed")
        url = ctx.agent.agent_sessions_url(ctx.project_id, ctx.agent_id)
        resp = ctx.agent.list_agent_sessions(ctx.project_id, ctx.agent_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        session_ids = [s.get("sessionId") for s in data.get("sessions", [])]
        assert ctx.session_id in session_ids, (
            f"created session {ctx.session_id!r} not in list {session_ids!r}"
        )
        assert data.get("total", 0) >= 1

    def test_get_session_transcript(self, ctx: SessionContext) -> None:
        """Fetch the session transcript and confirm the seeded content.

        Test scenario:
            Skips if no session was created. GETs the single session detail and
            serializes its ``messages`` to search the transcript text.

        Validation we are covering:
            Asserts HTTP 200, that the echoed ``sessionId`` matches, that there
            are at least two transcript messages, and that the seeded user name
            appears in the transcript.
        """
        if not ctx.session_id:
            pytest.skip("no session — test_invoke_creates_session did not succeed")
        url = f"{ctx.agent.agent_sessions_url(ctx.project_id, ctx.agent_id)}/{ctx.session_id}"
        resp = ctx.agent.get_agent_session(ctx.project_id, ctx.agent_id, ctx.session_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("sessionId") == ctx.session_id, "sessionId mismatch in transcript"
        messages = data.get("messages", [])
        assert len(messages) >= 2, f"expected >=2 transcript messages, got {len(messages)}"
        transcript = json.dumps(messages, default=str).lower()
        assert _USER_NAME.lower() in transcript, "seeded name not found in transcript"

    def test_rename_session(self, ctx: SessionContext) -> None:
        """Rename the session via PATCH and confirm the new name.

        Test scenario:
            Skips if no session was created. PATCHes the session with a new
            unique name.

        Validation we are covering:
            Asserts HTTP 200 and that the response ``name`` equals the new name.
        """
        if not ctx.session_id:
            pytest.skip("no session — test_invoke_creates_session did not succeed")
        new_name = unique_name("renamed-session")
        url = f"{ctx.agent.agent_sessions_url(ctx.project_id, ctx.agent_id)}/{ctx.session_id}"
        resp = ctx.agent.rename_agent_session(
            ctx.project_id, ctx.agent_id, ctx.session_id, new_name
        )
        log_exchange("PATCH", url, {"name": new_name}, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("name") == new_name, "session name not updated"

    def test_session_isolation(self, ctx: SessionContext) -> None:
        """Confirm a fresh session does not leak memory from another session.

        Test scenario:
            Skips if no agent exists. Invokes the agent on a brand-new session
            id asking for the user's name, which was only seeded under the prior
            session.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, and that the seeded user name
            does not appear in the output (no cross-session memory leak).
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        other_session_id = unique_name("session-id-other")
        request = AgentInvocationRequest(
            input="what is my name",
            session_id=other_session_id,
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        output = data.get("output") or ""
        assert output, "empty agent output"
        assert _USER_NAME.lower() not in output.lower(), (
            f"fresh session leaked memory from another thread; output={output!r}"
        )

    def test_delete_session(self, ctx: SessionContext) -> None:
        """Delete the session and confirm it is afterwards unreachable.

        Test scenario:
            Skips if no session was created. DELETEs the session, then issues a
            follow-up GET for the same session id.

        Validation we are covering:
            Asserts the delete returns HTTP 204 and that the subsequent GET
            returns HTTP 404.
        """
        if not ctx.session_id:
            pytest.skip("no session — test_invoke_creates_session did not succeed")
        url = f"{ctx.agent.agent_sessions_url(ctx.project_id, ctx.agent_id)}/{ctx.session_id}"
        resp = ctx.agent.delete_agent_session(ctx.project_id, ctx.agent_id, ctx.session_id)
        log_exchange("DELETE", url, None, resp)
        assert resp.status_code == 204, resp.text

        get_resp = ctx.agent.get_agent_session(
            ctx.project_id, ctx.agent_id, ctx.session_id
        )
        log_exchange("GET", url, None, get_resp)
        assert get_resp.status_code == 404, get_resp.text

    def test_get_unknown_session_404(self, ctx: SessionContext) -> None:
        """Fetch a non-existent session id and expect a 404.

        Test scenario:
            Skips if no agent exists. GETs the agent session detail using a
            randomly generated session id that was never created.

        Validation we are covering:
            Asserts the request returns HTTP 404.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        unknown = unique_name("does-not-exist")
        url = f"{ctx.agent.agent_sessions_url(ctx.project_id, ctx.agent_id)}/{unknown}"
        resp = ctx.agent.get_agent_session(ctx.project_id, ctx.agent_id, unknown)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 404, resp.text
