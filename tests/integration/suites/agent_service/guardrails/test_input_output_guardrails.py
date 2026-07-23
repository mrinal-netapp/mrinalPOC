"""Agent-service combined input+output guardrails suite.

Chained end-to-end flow against a live deployment:

    project -> model -> ONE agent with all six guardrails -> invoke (x6)

A single agent is provisioned with **all three guardrails on both directions**
(`pii_masker`, `secret_leakage`, `content_filter` as input *and* output rules),
then exercised with the **same inputs** used by the per-direction suites
(`test_input_guardrails.py` / `test_output_guardrails.py`).

**Rule order matters.** The pipeline runs rules in array order; a ``modify``
mutates the content seen by the next rule and a ``block`` short-circuits. Rules
are ordered ``[pii_masker, secret_leakage, content_filter]`` (content_filter
**last**) so that:

- `secret_leakage` (``modify``) redacts a JWT / connection string *before*
  `content_filter` (``block``) can see it — keeping those cases a ``200`` redact.
- `content_filter` still blocks (``400``) a secret that `secret_leakage` does
  **not** detect. The only such ``content_filter`` pattern is the **Google API
  key** (``AIza…``) — every other ``content_filter`` token (OpenAI/AWS/GitHub/
  Slack/Mailchimp/JWT) is also caught by `secret_leakage`, which would redact it
  first and prevent the block. So the two `content_filter` cases use a Google
  API key.

With this ordering every case keeps the **same outcome** as its isolated suite:

| Case | Input | Outcome |
| ---- | ----- | ------- |
| input pii_masker      | `…hello@gmail.com…`        | 200, transcript `[EMAIL_REDACTED]` |
| input content_filter  | Google API key `AIza…`     | 400 block |
| input secret_leakage  | JWT `eyJ…`                 | 200, transcript `[JWT_REDACTED]` |
| output pii_masker     | "…random email_id…"        | 200, output `[EMAIL_REDACTED]` |
| output secret_leakage | "db connection string"     | 200, output `[CONNECTION_STRING_REDACTED]` |

Input-redaction cases read the **session transcript** (the stored user message
is the LLM-effective, already-redacted input); output-redaction cases read the
invoke response `output`; block cases assert HTTP `400`. State flows between the
ordered methods through a single class-scoped `ComboGuardrailContext`.
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
PROJECT_NAME_PREFIX = "e2e-combo-guardrails"
PROJECT_SOURCE = "pytest-agent-combo-guardrails"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# Sensitive sample inputs (reused from the per-direction suites).
_EMAIL = "hello@gmail.com"
_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0."
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
)
# Google API key (`AIza…`) — the one content_filter pattern secret_leakage does
# NOT detect, so content_filter can still block even when ordered last.
_GOOGLE_API_KEY = "AIzaSyD-abcDEF1234567890ghijklMNOPqrstuvWXYZ"

# Output-direction prompts that steer the model into emitting the value. The
# connection-string prompt embeds a canonical, well-formed URI and asks the model
# to echo it verbatim — relying on the model to *generate* one is
# non-deterministic (it often emits ``Server=...;Password=...;`` style strings
# that the secret_leakage connection-string pattern does not match).
_OUT_EMAIL_PROMPT = (
    "Repeat the following text back to me exactly, character for character, "
    "with no extra words or formatting:\n" + _EMAIL
)

# Connection string that matches the secret_leakage stdlib supplement pattern:
# ``(?i)\b(?:postgres(?:ql)?|mysql|...)://[^\s'"]+``.
_SAMPLE_CONNECTION_STRING = "postgresql://admin:S3cr3tPass@db.example.com:5432/production"
_OUT_CONNECTION_STRING_PROMPT = (
    "Repeat the following text back to me exactly, character for character, "
    "with no extra words or formatting:\n" + _SAMPLE_CONNECTION_STRING
)

# Redaction markers the guardrails substitute on ``modify``.
_EMAIL_REDACTED = "[EMAIL_REDACTED]"
_JWT_REDACTED = "[JWT_REDACTED]"
_CONNECTION_STRING_REDACTED = "[CONNECTION_STRING_REDACTED]"

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
class ComboGuardrailContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _assert_guardrail_echoed(
    resp_json: dict, direction: str, expected_name: str
) -> None:
    """Assert the create-agent response echoes a guardrail by name + direction.

    ``direction`` is ``input_guardrails`` or ``output_guardrails``. Config-service
    echoes the ``guardrails`` object verbatim; lenient by design — only asserts
    when the ``guardrails`` key is present.
    """
    guardrails = resp_json.get("guardrails")
    if not guardrails:
        return
    names = [r.get("name") for r in guardrails.get(direction, [])]
    assert expected_name in names, (
        f"expected {direction} guardrail {expected_name!r} echoed in create "
        f"response, got {names!r}"
    )


def _transcript_user_messages(
    ctx: ComboGuardrailContext, agent_id: str, session_id: str
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
    return [str(m.get("content", "")) for m in messages if m.get("role") == "user"]


def _invoke_url(ctx: ComboGuardrailContext) -> str:
    return (
        f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
        f"/agents/{ctx.agent_id}/invoke"
    )


class TestInputOutputGuardrails:
    """Ordered combined-guardrails flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> ComboGuardrailContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = ComboGuardrailContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: ComboGuardrailContext) -> None:
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
        self, ctx: ComboGuardrailContext
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

    def test_add_and_validate_model(self, ctx: ComboGuardrailContext) -> None:
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

    def test_create_combined_agent(self, ctx: ComboGuardrailContext) -> None:
        """Create one agent carrying all six guardrails on both directions.

        Test scenario:
            Skips when no model exists. POSTs an agent to config-service with
            ``[pii_masker, secret_leakage, content_filter]`` as both input and
            output rules (content_filter last) plus sliding-window memory, and
            stores the agent id on the context.

        Validation we are covering:
            The create returns HTTP 201, the agent id matches the
            ``ag-xxxxxxxx`` pattern, and (when present) each of the three
            guardrails is echoed on both the input and output directions.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        # Order: pii_masker, secret_leakage, content_filter (content_filter LAST)
        # so secret_leakage redacts JWTs/connection strings before content_filter
        # would block them; content_filter still blocks the Google key it alone
        # detects. Same order on both directions.
        rules = [
            guardrail_rule(INPUT_PII_MASKER_ID, PII_MASKER),
            guardrail_rule(INPUT_SECRET_LEAKAGE_ID, SECRET_LEAKAGE),
            guardrail_rule(INPUT_CONTENT_FILTER_ID, CONTENT_FILTER),
        ]
        output_rules = [
            guardrail_rule(OUTPUT_PII_MASKER_ID, PII_MASKER),
            guardrail_rule(OUTPUT_SECRET_LEAKAGE_ID, SECRET_LEAKAGE),
            guardrail_rule(OUTPUT_CONTENT_FILTER_ID, CONTENT_FILTER),
        ]
        guardrails = guardrails_config(input_rules=rules, output_rules=output_rules)
        request = AgentCreationRequest(
            name=unique_name("combo-guardrails-agent"),
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
        ctx.agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id), f"unexpected agent id: {ctx.agent_id!r}"
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)
        for name in (PII_MASKER, SECRET_LEAKAGE, CONTENT_FILTER):
            _assert_guardrail_echoed(data, "input_guardrails", name)
            _assert_guardrail_echoed(data, "output_guardrails", name)

    # ------------------------------------------------------------------
    # Input-direction enforcement (same inputs as test_input_guardrails)
    # ------------------------------------------------------------------

    def test_invoke_input_pii_masker_redacts_email(
        self, ctx: ComboGuardrailContext
    ) -> None:
        """Confirm the combined agent redacts an email on the input direction.

        Test scenario:
            Skips when no agent exists. Invokes the agent with an input
            containing a raw email under a fresh session id, then fetches that
            session's transcript to read the stored (LLM-effective) user message.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output``, a user message
            is persisted, the raw email is absent from the stored input, and the
            ``[EMAIL_REDACTED]`` marker is present.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_combined_agent did not succeed")
        session_id = unique_name("combo-in-pii-sess")
        body = {"input": f"My email is {_EMAIL}, please confirm.", "sessionId": session_id}
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", _invoke_url(ctx), body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        assert invoke_resp.json().get("output"), "empty agent output"

        user_messages = _transcript_user_messages(ctx, ctx.agent_id, session_id)
        assert user_messages, "no user message persisted in transcript"
        joined = "\n".join(user_messages)
        assert _EMAIL not in joined, f"raw email leaked to the LLM-effective input: {joined!r}"
        assert _EMAIL_REDACTED in joined, (
            f"expected {_EMAIL_REDACTED} in redacted input, got: {joined!r}"
        )

    def test_invoke_input_content_filter_blocks_google_key(
        self, ctx: ComboGuardrailContext
    ) -> None:
        """Confirm content_filter still blocks the Google key on the input direction.

        Test scenario:
            Skips when no agent exists. Invokes the agent with an input
            containing a Google API key — the one content_filter pattern
            secret_leakage does not detect — so content_filter (ordered last)
            still blocks it.

        Validation we are covering:
            The invoke is rejected with HTTP 400 and the error payload contains
            both an ``error`` and an ``error_type`` field.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_combined_agent did not succeed")
        body = {"input": f"Here is the value {_GOOGLE_API_KEY} please verify."}
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", _invoke_url(ctx), body, invoke_resp)
        assert invoke_resp.status_code == 400, (
            f"content_filter must block the Google API key with HTTP 400, got "
            f"{invoke_resp.status_code}: {invoke_resp.text}"
        )
        data = invoke_resp.json()
        detail = data.get("detail", data)
        assert "error" in detail, f"400 response missing `error`: {data}"
        assert "error_type" in detail, f"400 response missing `error_type`: {data}"

    def test_invoke_input_secret_leakage_redacts_jwt(
        self, ctx: ComboGuardrailContext
    ) -> None:
        """Confirm the combined agent redacts a JWT on the input direction.

        Test scenario:
            Skips when no agent exists. Invokes the agent with an input
            containing a raw JWT under a fresh session id (secret_leakage redacts
            it before content_filter can block), then reads the session
            transcript's stored user message.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output``, a user message
            is persisted, the raw JWT is absent from the stored input, and the
            ``[JWT_REDACTED]`` marker is present.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_combined_agent did not succeed")
        session_id = unique_name("combo-in-secret-sess")
        body = {"input": f"My token is {_JWT} — keep it safe.", "sessionId": session_id}
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", _invoke_url(ctx), body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        assert invoke_resp.json().get("output"), "empty agent output"

        user_messages = _transcript_user_messages(ctx, ctx.agent_id, session_id)
        assert user_messages, "no user message persisted in transcript"
        joined = "\n".join(user_messages)
        assert _JWT not in joined, f"raw JWT leaked to the LLM-effective input: {joined!r}"
        assert _JWT_REDACTED in joined, (
            f"expected {_JWT_REDACTED} in redacted input, got: {joined!r}"
        )

    # ------------------------------------------------------------------
    # Output-direction enforcement (same inputs as test_output_guardrails)
    # ------------------------------------------------------------------

    def test_invoke_output_pii_masker_redacts_email(
        self, ctx: ComboGuardrailContext
    ) -> None:
        """Confirm the combined agent redacts an email on the output direction.

        Test scenario:
            Skips when no agent exists. Invokes the agent with a prompt that
            steers the model to emit a sample email, then reads the invoke
            response ``output`` directly.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output`` and the
            ``[EMAIL_REDACTED]`` marker is present in that output.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_combined_agent did not succeed")
        body = {"input": _OUT_EMAIL_PROMPT}
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", _invoke_url(ctx), body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        output = invoke_resp.json().get("output") or ""
        assert output, "empty agent output"
        assert _EMAIL_REDACTED in output, (
            f"expected {_EMAIL_REDACTED} in redacted output, got: {output!r}"
        )

    def test_invoke_output_secret_leakage_redacts_connection_string(
        self, ctx: ComboGuardrailContext
    ) -> None:
        """Confirm the combined agent redacts a DB string on the output direction.

        Test scenario:
            Skips when no agent exists. Invokes the agent with a prompt that
            steers the model to emit a sample DB connection string, then reads
            the invoke response ``output`` directly.

        Validation we are covering:
            The invoke returns HTTP 200 with non-empty ``output`` and the
            ``[CONNECTION_STRING_REDACTED]`` marker is present in that output.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_combined_agent did not succeed")
        body = {"input": _OUT_CONNECTION_STRING_PROMPT}
        invoke_resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", _invoke_url(ctx), body, invoke_resp)
        assert invoke_resp.status_code == 200, invoke_resp.text
        output = invoke_resp.json().get("output") or ""
        assert output, "empty agent output"
        assert _CONNECTION_STRING_REDACTED in output, (
            f"expected {_CONNECTION_STRING_REDACTED} in redacted output, got: {output!r}"
        )
