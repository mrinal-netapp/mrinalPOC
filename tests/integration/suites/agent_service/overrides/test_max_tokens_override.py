"""Agent-service per-invoke config-overrides suite — maxTokens.

Chained end-to-end flow against a live deployment:

    project -> model -> simple agent
            -> invoke (verbose prompt, configOverrides.max_tokens=10) -> short output

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`) and are built from the typed
`AgentInvocationRequest`. Unlike `temperature` / `model`, the effective
max-output-tokens cap is **not** echoed anywhere in the invoke response (there
is no `citations.respondingAgent.maxTokens` field). It is therefore validated
**indirectly via output length**: a deliberately verbose prompt is invoked with
a very small per-request `configOverrides.max_tokens` (10), so the cap forces
the model to stop almost immediately and the returned `output` must be very
short. State flows between the ordered methods through a single class-scoped
`MaxTokensContext`.
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
    pytest.mark.overrides,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-overrides"
PROJECT_SOURCE = "pytest-agent-overrides"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# A deliberately verbose prompt: without a cap the model produces a long
# answer; with max_tokens=10 the cap forces it to stop almost immediately.
_LONG_PROMPT = "Explain AI in detail in 1000 words"
_MAX_TOKENS_OVERRIDE = 10
# The capped turn must fall below this word count. With max_tokens=10 the
# deployment truncates the verbose prompt's answer to a mid-sentence fragment
# (~25 words observed), far below the uncapped length (~1000+ words); 50 keeps
# a robust margin above the observed truncation while still proving the cap.
_CAPPED_MAX_WORDS = 50


def _word_count(text: str) -> int:
    """Whitespace-delimited word count of a response output."""
    return len(text.split())


@dataclass
class MaxTokensContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    simple_agent_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestMaxTokensOverride:
    """Ordered maxTokens-override flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> MaxTokensContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = MaxTokensContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: MaxTokensContext) -> None:
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
        self, ctx: MaxTokensContext
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

    def test_add_and_validate_model(self, ctx: MaxTokensContext) -> None:
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

    def test_create_simple_agent(self, ctx: MaxTokensContext) -> None:
        """Create a plain agent with a verbose system prompt and no token cap.

        Test scenario:
            Skip if no model exists. POST an AgentCreationRequest whose system
            prompt asks for thorough, detailed answers, so a later capped invoke
            can be contrasted against the uncapped, naturally long output.

        Validation we are covering:
            HTTP 201, the returned agent id matches the ag-xxxxxxxx pattern, and
            the echoed modelId equals the provisioned model id.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("overrides-maxtokens-agent"),
            description="Plain agent used to compare uncapped vs maxTokens-capped output",
            role="assistant",
            system_prompt=(
                "You are a helpful assistant. Provide thorough, detailed, "
                "comprehensive answers."
            ),
            model_id=ctx.model_id,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.simple_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.simple_agent_id), (
            f"unexpected agent id: {ctx.simple_agent_id!r}"
        )
        assert data.get("modelId") == ctx.model_id
        ctx.resources.add_agent(ctx.simple_agent_id, ctx.project_id)

    def test_invoke_max_tokens_override(self, ctx: MaxTokensContext) -> None:
        """Apply a per-turn max_tokens override and confirm output is truncated.

        Test scenario:
            Skip if the simple agent was not created. Invoke with a deliberately
            verbose prompt and configOverrides.max_tokens=10 so the cap forces an
            almost immediate stop.

        Validation we are covering:
            HTTP 200, non-empty output, and the output word count stays below the
            capped threshold (50 words), proving the cap truncated the response.
        """
        if not ctx.simple_agent_id:
            pytest.skip("no simple agent — test_create_simple_agent did not succeed")
        request = AgentInvocationRequest(
            input=_LONG_PROMPT,
            config_overrides={"max_tokens": _MAX_TOKENS_OVERRIDE},
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.simple_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.simple_agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        output = data.get("output") or ""
        assert output, "empty agent output"
        words = _word_count(output)
        assert words < _CAPPED_MAX_WORDS, (
            f"configOverrides.max_tokens={_MAX_TOKENS_OVERRIDE} did not truncate the "
            f"output: got {words} words (expected < {_CAPPED_MAX_WORDS})"
        )
