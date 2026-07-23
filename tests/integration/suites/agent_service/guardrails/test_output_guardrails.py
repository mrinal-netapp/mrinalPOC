"""Agent-service output-guardrails suite.

Chained end-to-end flow against a live deployment:

    project -> model -> (per case) agent with a single output guardrail -> invoke

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`). Each case creates its own agent bound to
exactly one output guardrail (no MCP, no KBs):

- ``pii_masker``     — the model is prompted to emit a sample email; the
  guardrail **redacts** it (action ``modify``) so the response `output`
  contains ``[EMAIL_REDACTED]`` instead of a raw address.
- ``content_filter`` — the model is prompted to emit a JWT; the guardrail
  **blocks** the response with HTTP ``400`` (action ``block``, the engine
  default).
- ``secret_leakage`` — the model is prompted to emit a DB connection string;
  the guardrail **redacts** it (action ``modify``) so the response `output`
  contains a ``[..._REDACTED]`` marker.

Unlike the input suite, output guardrails act on the response that is returned
directly, so assertions read the invoke response `output` (redaction) or status
code (block) — no session memory / transcript is required. State flows between
the ordered methods through a single class-scoped `OutputGuardrailContext`.
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
    OUTPUT_CONTENT_FILTER_ID,
    OUTPUT_PII_MASKER_ID,
    OUTPUT_SECRET_LEAKAGE_ID,
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
PROJECT_NAME_PREFIX = "e2e-output-guardrails"
PROJECT_SOURCE = "pytest-agent-output-guardrails"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Prompts that steer the model into emitting the sensitive value the output
# guardrail should act on. The JWT/connection-string prompts embed a canonical,
# well-formed secret and ask the model to echo it verbatim — relying on the model
# to *generate* a valid secret is non-deterministic (it may refuse or emit a
# malformed placeholder that the guardrail's detector does not match).
# Email that matches the pii_masker email detector.
_SAMPLE_EMAIL = "hello@gmail.com"
_EMAIL_PROMPT = (
    "Repeat the following text back to me exactly, character for character, "
    "with no extra words or formatting:\n" + _SAMPLE_EMAIL
)

# Structurally valid JWT (header.payload.signature) that matches the
# content_filter JWT pattern: ``eyJ[...]\.[...]\.[...]``.
_SAMPLE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ."
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)
_JWT_PROMPT = (
    "Repeat the following text back to me exactly, character for character, "
    "with no extra words or formatting:\n" + _SAMPLE_JWT
)

# Connection string that matches the secret_leakage stdlib supplement pattern:
# ``(?i)\b(?:postgres(?:ql)?|mysql|...)://[^\s'"]+``.
_SAMPLE_CONNECTION_STRING = "postgresql://admin:S3cr3tPass@db.example.com:5432/production"
_CONNECTION_STRING_PROMPT = (
    "Repeat the following text back to me exactly, character for character, "
    "with no extra words or formatting:\n" + _SAMPLE_CONNECTION_STRING
)

# Markers the redacting guardrails substitute on ``modify``.
_EMAIL_REDACTED = "[EMAIL_REDACTED]"
_CONNECTION_STRING_REDACTED = "[CONNECTION_STRING_REDACTED]"


@dataclass
class OutputGuardrailContext:
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


def _assert_output_guardrail_echoed(resp_json: dict, expected_name: str) -> None:
    """Assert the create-agent response echoes the output guardrail by name.

    Config-service stores/echoes the ``guardrails`` object verbatim. Lenient by
    design: only asserts when the ``guardrails`` key is present, so a build that
    omits the echo does not fail the create test.
    """
    guardrails = resp_json.get("guardrails")
    if not guardrails:
        return
    names = [r.get("name") for r in guardrails.get("output_guardrails", [])]
    assert expected_name in names, (
        f"expected output guardrail {expected_name!r} echoed in create response, "
        f"got {names!r}"
    )


class TestOutputGuardrails:
    """Ordered output-guardrails flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> OutputGuardrailContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = OutputGuardrailContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: OutputGuardrailContext) -> None:
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
        self, ctx: OutputGuardrailContext
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

    def test_add_and_validate_model(self, ctx: OutputGuardrailContext) -> None:
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

    def test_create_pii_masker_agent(self, ctx: OutputGuardrailContext) -> None:
        """Create an agent bound to the output ``pii_masker`` guardrail.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with a
            single output ``pii_masker`` rule and stores the agent id on the
            shared context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) the create response
            echoes the ``pii_masker`` output guardrail by name.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        guardrails = guardrails_config(
            output_rules=[guardrail_rule(OUTPUT_PII_MASKER_ID, PII_MASKER)],
        )
        request = AgentCreationRequest(
            name=unique_name("out-pii-masker-agent"),
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
        ctx.pii_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.pii_agent_id), (
            f"unexpected agent id: {ctx.pii_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.pii_agent_id, ctx.project_id)
        _assert_output_guardrail_echoed(data, PII_MASKER)

    def test_invoke_pii_masker_redacts_email(self, ctx: OutputGuardrailContext) -> None:
        """Invoke the pii_masker agent and confirm the email is redacted on output.

        Test scenario:
            Skips when no agent exists. Invokes the agent with a prompt that
            steers the model to emit a sample email, then reads the invoke
            response ``output`` directly (output guardrails act on the response).

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output`` and the
            ``[EMAIL_REDACTED]`` marker is present in that output.
        """
        if not ctx.pii_agent_id:
            pytest.skip("no agent — test_create_pii_masker_agent did not succeed")
        body = {"input": _EMAIL_PROMPT}
        invoke_url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.pii_agent_id}/invoke"
        )
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.pii_agent_id, body)
        log_exchange("POST", invoke_url, body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        output = invoke_resp.json().get("output") or ""
        assert output, "empty agent output"
        assert _EMAIL_REDACTED in output, (
            f"expected {_EMAIL_REDACTED} in redacted output, got: {output!r}"
        )

    def test_create_content_filter_agent(self, ctx: OutputGuardrailContext) -> None:
        """Create an agent bound to the output ``content_filter`` guardrail.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with a
            single output ``content_filter`` rule and stores the agent id on the
            shared context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) the create response
            echoes the ``content_filter`` output guardrail by name.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        guardrails = guardrails_config(
            output_rules=[guardrail_rule(OUTPUT_CONTENT_FILTER_ID, CONTENT_FILTER)],
        )
        request = AgentCreationRequest(
            name=unique_name("out-content-filter-agent"),
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
        _assert_output_guardrail_echoed(data, CONTENT_FILTER)

    def test_invoke_content_filter_blocks_jwt(
        self, ctx: OutputGuardrailContext
    ) -> None:
        """Invoke the content_filter agent and confirm the JWT response is blocked.

        Test scenario:
            Skips when no agent exists. Invokes the agent with a prompt that
            steers the model to emit a sample JWT, expecting the output guardrail
            to block the response.

        Validation we are covering:
            The invoke is rejected with HTTP 400 and the error payload contains
            both an ``error`` and an ``error_type`` field.
        """
        if not ctx.content_filter_agent_id:
            pytest.skip("no agent — test_create_content_filter_agent did not succeed")
        body = {"input": _JWT_PROMPT}
        invoke_url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.content_filter_agent_id}/invoke"
        )
        invoke_resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.content_filter_agent_id, body
        )
        log_exchange("POST", invoke_url, body, invoke_resp)
        assert invoke_resp.status_code == 400, (
            f"content_filter must block the JWT in the response with HTTP 400, got "
            f"{invoke_resp.status_code}: {invoke_resp.text}"
        )
        data = invoke_resp.json()
        detail = data.get("detail", data)
        assert "error" in detail, f"400 response missing `error`: {data}"
        assert "error_type" in detail, f"400 response missing `error_type`: {data}"

    def test_create_secret_leakage_agent(self, ctx: OutputGuardrailContext) -> None:
        """Create an agent bound to the output ``secret_leakage`` guardrail.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with a
            single output ``secret_leakage`` rule and stores the agent id on the
            shared context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) the create response
            echoes the ``secret_leakage`` output guardrail by name.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        guardrails = guardrails_config(
            output_rules=[guardrail_rule(OUTPUT_SECRET_LEAKAGE_ID, SECRET_LEAKAGE)],
        )
        request = AgentCreationRequest(
            name=unique_name("out-secret-leakage-agent"),
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
        ctx.secret_leakage_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.secret_leakage_agent_id), (
            f"unexpected agent id: {ctx.secret_leakage_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.secret_leakage_agent_id, ctx.project_id)
        _assert_output_guardrail_echoed(data, SECRET_LEAKAGE)

    def test_invoke_secret_leakage_redacts_connection_string(
        self, ctx: OutputGuardrailContext
    ) -> None:
        """Invoke the secret_leakage agent and confirm the DB string is redacted.

        Test scenario:
            Skips when no agent exists. Invokes the agent with a prompt that
            steers the model to emit a sample DB connection string, then reads
            the invoke response ``output`` directly.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output`` and the
            ``[CONNECTION_STRING_REDACTED]`` marker is present in that output.
        """
        if not ctx.secret_leakage_agent_id:
            pytest.skip("no agent — test_create_secret_leakage_agent did not succeed")
        body = {"input": _CONNECTION_STRING_PROMPT}
        invoke_url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.secret_leakage_agent_id}/invoke"
        )
        invoke_resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.secret_leakage_agent_id, body
        )
        log_exchange("POST", invoke_url, body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        output = invoke_resp.json().get("output") or ""
        assert output, "empty agent output"
        assert _CONNECTION_STRING_REDACTED in output, (
            f"expected {_CONNECTION_STRING_REDACTED} in redacted output, got: {output!r}"
        )
