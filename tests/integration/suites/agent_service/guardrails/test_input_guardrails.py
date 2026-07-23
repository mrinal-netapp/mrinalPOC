"""Agent-service input-guardrails suite.

Chained end-to-end flow against a live deployment:

    project -> model -> (per case) agent with a single input guardrail -> invoke

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`). Each case creates its own agent bound to
exactly one input guardrail (no MCP, no KBs):
- ``pii_masker``     — input ``hello@gmail.com`` is **redacted** before the LLM
  sees it (action ``modify``); proven by reading the stored session transcript.
- ``content_filter`` — input containing an OpenAI API key is **blocked** with
  HTTP ``400`` (action ``block``).
- ``secret_leakage`` — input containing a JWT is **redacted** before the LLM
  sees it (action ``modify``); proven via the session transcript.

Same-turn ``citations`` does not expose the LLM-effective (redacted) input, so
the redaction cases enable session memory and assert against the stored user
message (which is the already-redacted input the LLM received). State flows
between the ordered methods through a single class-scoped `InputGuardrailContext`.
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
from lib.models.guardrails import (
    CONTENT_FILTER,
    INPUT_CONTENT_FILTER_ID,
    INPUT_PII_MASKER_ID,
    INPUT_SECRET_LEAKAGE_ID,
    PII_MASKER,
    SECRET_LEAKAGE,
    guardrail_rule,
    guardrails_config,
)
from lib.models.resources import SuiteResources

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.guardrails,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-input-guardrails"
PROJECT_SOURCE = "pytest-agent-input-guardrails"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Sensitive sample inputs.
_EMAIL = "hello@gmail.com"
_OPENAI_API_KEY = "sk-abcdefghij1234567890ABCDEFGHIJklmno"
_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0."
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)

# Redaction markers the guardrails substitute on ``modify``.
_EMAIL_REDACTED = "[EMAIL_REDACTED]"
_JWT_REDACTED = "[JWT_REDACTED]"

# Memory config so the session store persists the (redacted) user turn.
_MEMORY_TYPE = "sliding_window"
_MEMORY_CONFIG = {"windowSize": 20}
_MEMORY_CONTEXT = {
    "enabled": True,
    "message_retention_policy": "sliding_window",
    "message_history_limit": 20,
    "session_history_limit": 10,
}


@dataclass
class InputGuardrailContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    pii_agent_id: str = ""
    content_filter_agent_id: str = ""
    secret_leakage_agent_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _assert_guardrail_echoed(resp_json: dict, expected_name: str) -> None:
    """Assert the create-agent response echoes the input guardrail by name.

    Config-service stores/echoes the ``guardrails`` object verbatim. Lenient by
    design: only asserts when the ``guardrails`` key is present, so a build that
    omits the echo does not fail the create test.
    """
    guardrails = resp_json.get("guardrails")
    if not guardrails:
        return
    names = [r.get("name") for r in guardrails.get("input_guardrails", [])]
    assert expected_name in names, (
        f"expected input guardrail {expected_name!r} echoed in create response, "
        f"got {names!r}"
    )


def _transcript_user_messages(
    ctx: InputGuardrailContext, agent_id: str, session_id: str
) -> list[str]:
    """Fetch the session transcript and return all user-message contents.

    The stored user message is the LLM-effective (already-redacted) input, so
    asserting against it proves what reached the model.
    """
    url = f"{ctx.agent.agent_sessions_url(ctx.project_id, agent_id)}/{session_id}"
    resp = ctx.agent.get_agent_session(ctx.project_id, agent_id, session_id)
    log_exchange("GET", url, None, resp)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    messages = data.get("messages", [])
    return [
        str(m.get("content", ""))
        for m in messages
        if m.get("role") == "user"
    ]


class TestInputGuardrails:
    """Ordered input-guardrails flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> InputGuardrailContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = InputGuardrailContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: InputGuardrailContext) -> None:
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
        self, ctx: InputGuardrailContext
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

    def test_add_and_validate_model(self, ctx: InputGuardrailContext) -> None:
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

    def test_create_pii_masker_agent(self, ctx: InputGuardrailContext) -> None:
        """Create an agent bound to the input ``pii_masker`` guardrail.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with a
            single input ``pii_masker`` rule plus sliding-window memory so the
            session store persists turns; stores the agent id on the context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) the create response
            echoes the ``pii_masker`` input guardrail by name.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        guardrails = guardrails_config(
            input_rules=[guardrail_rule(INPUT_PII_MASKER_ID, PII_MASKER)],
        )
        request = AgentCreationRequest(
            name=unique_name("pii-masker-agent"),
            role="assistant",
            system_prompt="You are a helpful assistant. Be clear and concise.",
            model_id=ctx.model_id,
            memory_type=_MEMORY_TYPE,
            memory_config=_MEMORY_CONFIG,
            memory_context=_MEMORY_CONTEXT,
            guardrails=guardrails,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.pii_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.pii_agent_id), (
            f"unexpected agent id: {ctx.pii_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.pii_agent_id, ctx.project_id)
        _assert_guardrail_echoed(data, PII_MASKER)

    def test_invoke_pii_masker_redacts_email(self, ctx: InputGuardrailContext) -> None:
        """Invoke the pii_masker agent and confirm the email is redacted on input.

        Test scenario:
            Skips when no agent exists. Invokes the agent with an input
            containing a raw email under a fresh session id, then fetches that
            session's transcript to read the LLM-effective (stored) user message.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output``, a user message
            is persisted, the raw email is absent from the stored input, and the
            ``[EMAIL_REDACTED]`` marker is present.
        """
        if not ctx.pii_agent_id:
            pytest.skip("no agent — test_create_pii_masker_agent did not succeed")
        session_id = unique_name("pii-sess")
        body = {"input": f"My email is {_EMAIL}, please confirm.", "sessionId": session_id}
        invoke_url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.pii_agent_id}/invoke"
        )
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.pii_agent_id, body)
        log_exchange("POST", invoke_url, body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        assert invoke_resp.json().get("output"), "empty agent output"

        user_messages = _transcript_user_messages(ctx, ctx.pii_agent_id, session_id)
        assert user_messages, "no user message persisted in transcript"
        joined = "\n".join(user_messages)
        assert _EMAIL not in joined, (
            f"raw email leaked to the LLM-effective input: {joined!r}"
        )
        assert _EMAIL_REDACTED in joined, (
            f"expected {_EMAIL_REDACTED} in redacted input, got: {joined!r}"
        )

    def test_create_content_filter_agent(self, ctx: InputGuardrailContext) -> None:
        """Create an agent bound to the input ``content_filter`` guardrail.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with a
            single input ``content_filter`` rule (no memory) and stores the
            agent id on the context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) the create response
            echoes the ``content_filter`` input guardrail by name.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        guardrails = guardrails_config(
            input_rules=[guardrail_rule(INPUT_CONTENT_FILTER_ID, CONTENT_FILTER)],
        )
        request = AgentCreationRequest(
            name=unique_name("content-filter-agent"),
            role="assistant",
            system_prompt="You are a helpful assistant. Be clear and concise.",
            model_id=ctx.model_id,
            guardrails=guardrails,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.content_filter_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.content_filter_agent_id), (
            f"unexpected agent id: {ctx.content_filter_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.content_filter_agent_id, ctx.project_id)
        _assert_guardrail_echoed(data, CONTENT_FILTER)

    def test_invoke_content_filter_blocks_api_key(
        self, ctx: InputGuardrailContext
    ) -> None:
        """Invoke the content_filter agent and confirm the API key is blocked.

        Test scenario:
            Skips when no agent exists. Invokes the agent with an input
            containing an OpenAI API key, expecting the input guardrail to block
            the request before the LLM sees it.

        Validation we are covering:
            The invoke is rejected with HTTP 400 and the error payload contains
            both an ``error`` and an ``error_type`` field.
        """
        if not ctx.content_filter_agent_id:
            pytest.skip("no agent — test_create_content_filter_agent did not succeed")
        body = {"input": f"Here is my key {_OPENAI_API_KEY} — store it."}
        invoke_url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.content_filter_agent_id}/invoke"
        )
        invoke_resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.content_filter_agent_id, body
        )
        log_exchange("POST", invoke_url, body, invoke_resp)
        assert invoke_resp.status_code == 400, (
            f"content_filter must block the API key with HTTP 400, got "
            f"{invoke_resp.status_code}: {invoke_resp.text}"
        )
        data = invoke_resp.json()
        detail = data.get("detail", data)
        assert "error" in detail, f"400 response missing `error`: {data}"
        assert "error_type" in detail, f"400 response missing `error_type`: {data}"

    def test_create_secret_leakage_agent(self, ctx: InputGuardrailContext) -> None:
        """Create an agent bound to the input ``secret_leakage`` guardrail.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with a
            single input ``secret_leakage`` rule plus sliding-window memory so
            the session store persists turns; stores the agent id on the context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) the create response
            echoes the ``secret_leakage`` input guardrail by name.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        guardrails = guardrails_config(
            input_rules=[guardrail_rule(INPUT_SECRET_LEAKAGE_ID, SECRET_LEAKAGE)],
        )
        request = AgentCreationRequest(
            name=unique_name("secret-leakage-agent"),
            role="assistant",
            system_prompt="You are a helpful assistant. Be clear and concise.",
            model_id=ctx.model_id,
            memory_type=_MEMORY_TYPE,
            memory_config=_MEMORY_CONFIG,
            memory_context=_MEMORY_CONTEXT,
            guardrails=guardrails,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.secret_leakage_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.secret_leakage_agent_id), (
            f"unexpected agent id: {ctx.secret_leakage_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.secret_leakage_agent_id, ctx.project_id)
        _assert_guardrail_echoed(data, SECRET_LEAKAGE)

    def test_invoke_secret_leakage_redacts_jwt(
        self, ctx: InputGuardrailContext
    ) -> None:
        """Invoke the secret_leakage agent and confirm the JWT is redacted on input.

        Test scenario:
            Skips when no agent exists. Invokes the agent with an input
            containing a raw JWT under a fresh session id, then fetches that
            session's transcript to read the LLM-effective (stored) user message.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output``, a user message
            is persisted, the raw JWT is absent from the stored input, and the
            ``[JWT_REDACTED]`` marker is present.
        """
        if not ctx.secret_leakage_agent_id:
            pytest.skip("no agent — test_create_secret_leakage_agent did not succeed")
        session_id = unique_name("secret-sess")
        body = {"input": f"My token is {_JWT} — keep it safe.", "sessionId": session_id}
        invoke_url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.secret_leakage_agent_id}/invoke"
        )
        invoke_resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.secret_leakage_agent_id, body
        )
        log_exchange("POST", invoke_url, body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        assert invoke_resp.json().get("output"), "empty agent output"

        user_messages = _transcript_user_messages(
            ctx, ctx.secret_leakage_agent_id, session_id
        )
        assert user_messages, "no user message persisted in transcript"
        joined = "\n".join(user_messages)
        assert _JWT not in joined, (
            f"raw JWT leaked to the LLM-effective input: {joined!r}"
        )
        assert _JWT_REDACTED in joined, (
            f"expected {_JWT_REDACTED} in redacted input, got: {joined!r}"
        )
