"""Agent-service per-invoke config-overrides suite — temperature.

Chained end-to-end flow against a live deployment:

    project -> model -> simple agent -> invoke (citations expose model/temp)
            -> configured agent (temperature=1.6, maxTokens=100)
            -> invoke (citations echo configured temperature)
            -> invoke with configOverrides.temperature=0.2 (override wins)
            -> invoke again with no override (reverts to configured 1.6)

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`) and are built from the typed
`AgentInvocationRequest`. The suite proves two things: (1) an agent's
configured temperature surfaces in `citations.respondingAgent.temperature`,
and (2) a per-request `configOverrides.temperature` is applied for that turn
only and does not mutate the stored agent config. State flows between the
ordered methods through a single class-scoped `OverridesContext`.
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

# Configured (stored) temperature for the configured agent, and the per-turn
# override value. Both are well inside the 0..2 validated range and far enough
# apart to make the override unambiguous.
_CONFIGURED_TEMPERATURE = 1.6
_OVERRIDE_TEMPERATURE = 0.2
_TEMP_TOLERANCE = 1e-6


@dataclass
class OverridesContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    simple_agent_id: str = ""
    configured_agent_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _responding_agent(data: dict) -> dict:
    """Extract ``citations.respondingAgent`` (or empty dict) from a response."""
    citations = data.get("citations") or {}
    return citations.get("respondingAgent") or {}


class TestTemperatureOverride:
    """Ordered temperature-override flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> OverridesContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = OverridesContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: OverridesContext) -> None:
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
        self, ctx: OverridesContext
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

    def test_add_and_validate_model(self, ctx: OverridesContext) -> None:
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

    def test_create_simple_agent(self, ctx: OverridesContext) -> None:
        """Create a plain agent with no explicit temperature configured.

        Test scenario:
            Skip if no model exists. POST an AgentCreationRequest bound to the
            model with no temperature/maxTokens, used later to read back the
            default model/temperature from invoke citations.

        Validation we are covering:
            HTTP 201, the returned agent id matches the ag-xxxxxxxx pattern, and
            the echoed modelId equals the provisioned model id.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("overrides-simple-agent"),
            description="Plain agent used to read back default model/temperature",
            role="assistant",
            system_prompt="You are a helpful assistant. Answer briefly.",
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

    def test_invoke_simple_agent_citations_present(self, ctx: OverridesContext) -> None:
        """Invoke the simple agent and confirm model/temperature provenance.

        Test scenario:
            Skip if the simple agent was not created. Invoke it with a trivial
            input and inspect citations.respondingAgent in the response.

        Validation we are covering:
            HTTP 200, non-empty output, respondingAgent is present, and both its
            model and temperature fields are populated (not null).
        """
        if not ctx.simple_agent_id:
            pytest.skip("no simple agent — test_create_simple_agent did not succeed")
        request = AgentInvocationRequest(input="Hi")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.simple_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.simple_agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        responding = _responding_agent(data)
        assert responding, "citations.respondingAgent missing from invoke response"
        assert responding.get("model"), (
            "citations.respondingAgent.model is empty — model provenance missing"
        )
        assert responding.get("temperature") is not None, (
            "citations.respondingAgent.temperature is null — temperature "
            "provenance missing"
        )

    def test_create_configured_agent(self, ctx: OverridesContext) -> None:
        """Create an agent with an explicit configured temperature and maxTokens.

        Test scenario:
            Skip if no model exists. POST an AgentCreationRequest with
            temperature=1.6 and maxTokens=100 so later invokes can read the
            stored temperature back from citations.

        Validation we are covering:
            HTTP 201, the agent id matches the ag-xxxxxxxx pattern, the echoed
            modelId matches, and the echoed temperature equals 1.6 within
            tolerance.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("overrides-configured-agent"),
            description="Agent with an explicit temperature + maxTokens",
            role="assistant",
            system_prompt="You are a helpful assistant. Answer briefly.",
            model_id=ctx.model_id,
            temperature=_CONFIGURED_TEMPERATURE,
            max_tokens=100,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.configured_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.configured_agent_id), (
            f"unexpected agent id: {ctx.configured_agent_id!r}"
        )
        assert data.get("modelId") == ctx.model_id
        assert data.get("temperature") == pytest.approx(
            _CONFIGURED_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), f"configured temperature not echoed: {data.get('temperature')!r}"
        ctx.resources.add_agent(ctx.configured_agent_id, ctx.project_id)

    def test_invoke_configured_agent_citations(self, ctx: OverridesContext) -> None:
        """Invoke the configured agent and confirm its stored temperature surfaces.

        Test scenario:
            Skip if the configured agent was not created. Invoke it with no
            overrides and read citations.respondingAgent from the response.

        Validation we are covering:
            HTTP 200, non-empty output, respondingAgent present with a non-empty
            model, and its temperature equals the configured 1.6 within
            tolerance.
        """
        if not ctx.configured_agent_id:
            pytest.skip(
                "no configured agent — test_create_configured_agent did not succeed"
            )
        request = AgentInvocationRequest(input="Hi")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.configured_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.configured_agent_id, request
        )
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        responding = _responding_agent(data)
        assert responding, "citations.respondingAgent missing from invoke response"
        assert responding.get("model"), "citations.respondingAgent.model is empty"
        assert responding.get("temperature") == pytest.approx(
            _CONFIGURED_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), (
            "configured temperature not reflected in citations: "
            f"{responding.get('temperature')!r}"
        )

    def test_invoke_temperature_override(self, ctx: OverridesContext) -> None:
        """Apply a per-turn temperature override and confirm it is turn-scoped.

        Test scenario:
            Skip if the configured agent was not created. Invoke once with
            configOverrides.temperature=0.2, then re-invoke with no override to
            confirm the stored config is unchanged.

        Validation we are covering:
            Both invokes return HTTP 200 with non-empty output; the override turn
            reports temperature 0.2 (and not 1.6), and the revert turn reports the
            configured 1.6, proving the override did not mutate stored config.
        """
        if not ctx.configured_agent_id:
            pytest.skip(
                "no configured agent — test_create_configured_agent did not succeed"
            )
        # 1) Invoke with a per-request temperature override; it must win.
        override_request = AgentInvocationRequest(
            input="Hi",
            config_overrides={"temperature": _OVERRIDE_TEMPERATURE},
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.configured_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.configured_agent_id, override_request
        )
        log_exchange("POST", url, override_request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        responding = _responding_agent(data)
        assert responding.get("temperature") == pytest.approx(
            _OVERRIDE_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), (
            "configOverrides.temperature was not applied: "
            f"{responding.get('temperature')!r}"
        )
        assert responding.get("temperature") != pytest.approx(
            _CONFIGURED_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), "override temperature unexpectedly equals the configured value"

        # 2) Re-invoke WITHOUT an override; temperature must revert to the
        #    stored configured value, proving the override was per-turn and did
        #    not mutate the agent config.
        revert_request = AgentInvocationRequest(input="Hi")
        resp2 = ctx.agent.invoke_agent(
            ctx.project_id, ctx.configured_agent_id, revert_request
        )
        log_exchange("POST", url, revert_request.to_body(), resp2)
        assert resp2.status_code == 200, resp2.text
        responding2 = _responding_agent(resp2.json())
        assert responding2.get("temperature") == pytest.approx(
            _CONFIGURED_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), (
            "temperature did not revert to the configured value after the "
            f"override turn: {responding2.get('temperature')!r}"
        )
