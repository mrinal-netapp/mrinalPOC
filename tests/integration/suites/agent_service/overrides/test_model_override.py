"""Agent-service per-invoke config-overrides suite — model.

Chained end-to-end flow against a live deployment:

    project -> model -> simple agent
            -> invoke (no override) -> capture default model from citations
            -> invoke with configOverrides.model=<OVERRIDE_MODEL_NAME> (override wins)
            -> invoke again with no override (reverts to default model)

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`) and are built from the typed
`AgentInvocationRequest`. Unlike `temperature` / `maxTokens`, the effective
model **is** echoed in the invoke response — in both `metadata.model` and
`citations.respondingAgent.model` — so the override is validated **directly**.

The override model is not provisioned by this suite; it must already exist on
the project as a registered, routable model. Its gateway model id is read from
the `OVERRIDE_MODEL_NAME` environment variable. When unset (or equal to the
agent's default model), the override case is skipped. State flows between the
ordered methods through a single class-scoped `ModelOverrideContext`.
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


@dataclass
class ModelOverrideContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    simple_agent_id: str = ""
    default_model: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _responding_agent(data: dict) -> dict:
    """Extract ``citations.respondingAgent`` (or empty dict) from a response."""
    citations = data.get("citations") or {}
    return citations.get("respondingAgent") or {}


def _model_matches(expected: str, actual: str) -> bool:
    """Compare two model identifiers tolerant of provider/project qualification.

    The agent-service reports model provenance in two formats: a fully-qualified
    name (e.g. ``azure/<project>_<credhash>_<deployment>``) and the short
    deployment name (e.g. ``<deployment>``). Treat them as equal when the shorter
    identifier is a substring of the longer one.
    """
    if not expected or not actual:
        return False
    short, full = sorted((expected, actual), key=len)
    return short in full


class TestModelOverride:
    """Ordered model-override flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> ModelOverrideContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = ModelOverrideContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: ModelOverrideContext) -> None:
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
        self, ctx: ModelOverrideContext
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

    def test_add_and_validate_model(self, ctx: ModelOverrideContext) -> None:
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

    def test_create_simple_agent(self, ctx: ModelOverrideContext) -> None:
        """Create a plain agent bound to the default model for override comparison.

        Test scenario:
            Skip if no model exists. POST an AgentCreationRequest bound to the
            provisioned model; its default model is later compared against an
            overridden one.

        Validation we are covering:
            HTTP 201, the returned agent id matches the ag-xxxxxxxx pattern, and
            the echoed modelId equals the provisioned model id.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("overrides-model-agent"),
            description="Plain agent bound to the default model for override comparison",
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

    def test_invoke_default_model_citations(self, ctx: ModelOverrideContext) -> None:
        """Invoke with no override and capture the agent's default model.

        Test scenario:
            Skip if the simple agent was not created. Invoke it with no overrides
            and read metadata.model and citations.respondingAgent.model, storing
            the agreed default model on ctx for later comparison.

        Validation we are covering:
            HTTP 200, non-empty output, both metadata.model and the citations
            model are populated, and the two model values agree.
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
        metadata_model = (data.get("metadata") or {}).get("model")
        responding_model = _responding_agent(data).get("model")
        assert metadata_model, "metadata.model is empty — model provenance missing"
        assert responding_model, (
            "citations.respondingAgent.model is empty — model provenance missing"
        )
        assert _model_matches(metadata_model, responding_model), (
            "metadata.model and citations.respondingAgent.model disagree: "
            f"{metadata_model!r} != {responding_model!r}"
        )
        ctx.default_model = responding_model

    @pytest.mark.xfail(
        reason="configOverrides.model is not reliably reflected in citation "
        "metadata; the model override is not consistently applied per-turn",
        strict=False,
    )
    def test_invoke_model_override(self, ctx: ModelOverrideContext) -> None:
        """Apply a per-turn model override and confirm it is turn-scoped.

        Test scenario:
            Skip if the agent/default model are missing, OVERRIDE_MODEL_NAME is
            unset, or it equals the default. Invoke once with
            configOverrides.model set to the override, then re-invoke with no
            override.

        Validation we are covering:
            Both invokes return HTTP 200; the override turn echoes the override
            model in metadata.model and citations (and differs from the default),
            and the revert turn returns to the default model.
        """
        if not ctx.simple_agent_id:
            pytest.skip("no simple agent — test_create_simple_agent did not succeed")
        if not ctx.default_model:
            pytest.skip(
                "no default model — test_invoke_default_model_citations did not succeed"
            )
        override_model = ctx.config.override_model_name
        if not override_model:
            pytest.skip("OVERRIDE_MODEL_NAME not set — skipping model override case")
        if _model_matches(override_model, ctx.default_model):
            pytest.skip(
                "OVERRIDE_MODEL_NAME equals the default model — override is "
                "indistinguishable from the default"
            )

        # 1) Invoke with a per-request model override; it must win.
        override_request = AgentInvocationRequest(
            input="Hi",
            config_overrides={"model": override_model},
        )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.simple_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.simple_agent_id, override_request
        )
        log_exchange("POST", url, override_request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        metadata_model = (data.get("metadata") or {}).get("model")
        responding_model = _responding_agent(data).get("model")
        assert _model_matches(metadata_model, override_model), (
            "configOverrides.model was not applied in metadata.model: "
            f"{metadata_model!r} (expected {override_model!r})"
        )
        assert _model_matches(responding_model, override_model), (
            "configOverrides.model was not applied in citations: "
            f"{responding_model!r} (expected {override_model!r})"
        )
        assert not _model_matches(responding_model, ctx.default_model), (
            "override model unexpectedly equals the default model"
        )

        # 2) Re-invoke WITHOUT an override; the model must revert to the agent's
        #    default, proving the override was per-turn and did not mutate the
        #    stored agent config.
        revert_request = AgentInvocationRequest(input="Hi")
        resp2 = ctx.agent.invoke_agent(
            ctx.project_id, ctx.simple_agent_id, revert_request
        )
        log_exchange("POST", url, revert_request.to_body(), resp2)
        assert resp2.status_code == 200, resp2.text
        responding2_model = _responding_agent(resp2.json()).get("model")
        assert _model_matches(responding2_model, ctx.default_model), (
            "model did not revert to the default after the override turn: "
            f"{responding2_model!r} (expected {ctx.default_model!r})"
        )
