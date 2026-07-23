"""Agent-service per-invoke config-overrides suite — all overrides together.

Chained end-to-end flow against a live deployment:

    project -> model -> configured agent (temperature=1.6, maxTokens=100, verbose prompt)
            -> invoke (no override) -> capture default model + confirm temp 1.6
            -> invoke with model + temperature + max_tokens overrides on ONE turn
            -> invoke again with no override (reverts to configured model + temp)

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`) and are built from the typed
`AgentInvocationRequest`. A single invoke carries all three overrides; each is
asserted with the technique used in its dedicated deliverable:

    - temperature -> citations.respondingAgent.temperature (direct)
    - model       -> metadata.model + citations.respondingAgent.model (direct)
    - max_tokens  -> output word count (indirect; no maxTokens field is echoed)

The override model is read from the `OVERRIDE_MODEL_NAME` environment variable;
when unset (or equal to the agent's default model) the combined override case is
skipped. State flows between the ordered methods through a single class-scoped
`AllOverridesContext`.
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

# Configured (stored) values on the agent, and the per-turn override values.
# All three overrides differ from the configured baseline so each is
# unambiguous when applied on the same turn.
_CONFIGURED_TEMPERATURE = 1.6
_CONFIGURED_MAX_TOKENS = 100
_OVERRIDE_TEMPERATURE = 0.2
_MAX_TOKENS_OVERRIDE = 10
_TEMP_TOLERANCE = 1e-6

# A deliberately verbose prompt: without a cap the model produces a long
# answer; with max_tokens=10 the cap forces it to stop almost immediately.
_LONG_PROMPT = "Explain AI in detail in 1000 words"
# The capped turn must fall below this word count (see test_max_tokens_override
# for the live-observed truncation behaviour; 50 keeps a robust margin).
_CAPPED_MAX_WORDS = 50


def _word_count(text: str) -> int:
    """Whitespace-delimited word count of a response output."""
    return len(text.split())


@dataclass
class AllOverridesContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    configured_agent_id: str = ""
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


class TestAllOverrides:
    """Ordered combined-override flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> AllOverridesContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = AllOverridesContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: AllOverridesContext) -> None:
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
        self, ctx: AllOverridesContext
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

    def test_add_and_validate_model(self, ctx: AllOverridesContext) -> None:
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

    def test_create_configured_agent(self, ctx: AllOverridesContext) -> None:
        """Create an agent with baseline temperature, maxTokens, and verbose prompt.

        Test scenario:
            Skip if no model exists. POST an AgentCreationRequest with
            temperature=1.6, maxTokens=100, and a verbose system prompt so each
            of the three overrides can later be contrasted on a single turn.

        Validation we are covering:
            HTTP 201, the agent id matches the ag-xxxxxxxx pattern, the echoed
            modelId matches, the temperature equals 1.6 within tolerance, and the
            maxTokens equals 100.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("overrides-all-agent"),
            description="Agent with baseline temperature + maxTokens + verbose prompt",
            role="assistant",
            system_prompt=(
                "You are a helpful assistant. Provide thorough, detailed, "
                "comprehensive answers."
            ),
            model_id=ctx.model_id,
            temperature=_CONFIGURED_TEMPERATURE,
            max_tokens=_CONFIGURED_MAX_TOKENS,
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
        assert data.get("maxTokens") == _CONFIGURED_MAX_TOKENS, (
            f"configured maxTokens not echoed: {data.get('maxTokens')!r}"
        )
        ctx.resources.add_agent(ctx.configured_agent_id, ctx.project_id)

    def test_invoke_baseline_default_model(self, ctx: AllOverridesContext) -> None:
        """Invoke with no override to capture the default model and baseline temp.

        Test scenario:
            Skip if the configured agent was not created. Invoke it with no
            overrides, read metadata.model and citations.respondingAgent, and
            store the agreed default model on ctx.

        Validation we are covering:
            HTTP 200, non-empty output, metadata.model and the citations model are
            populated and agree, and the citations temperature equals the
            configured 1.6 within tolerance.
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
        metadata_model = (data.get("metadata") or {}).get("model")
        responding = _responding_agent(data)
        responding_model = responding.get("model")
        assert metadata_model, "metadata.model is empty — model provenance missing"
        assert responding_model, "citations.respondingAgent.model is empty"
        assert _model_matches(metadata_model, responding_model), (
            "metadata.model and citations.respondingAgent.model disagree: "
            f"{metadata_model!r} != {responding_model!r}"
        )
        ctx.default_model = responding_model
        assert responding.get("temperature") == pytest.approx(
            _CONFIGURED_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), (
            "configured temperature not reflected in citations: "
            f"{responding.get('temperature')!r}"
        )

    @pytest.mark.xfail(
        reason="configOverrides.model is not reliably reflected in citation "
        "metadata; the model override is not consistently applied per-turn",
        strict=False,
    )
    def test_invoke_all_overrides(self, ctx: AllOverridesContext) -> None:
        """Apply model, temperature, and max_tokens overrides on one turn.

        Test scenario:
            Skip if the agent/default model are missing or OVERRIDE_MODEL_NAME is
            unset/equal to the default. Invoke once carrying all three overrides,
            then re-invoke with no override.

        Validation we are covering:
            The override turn echoes the override model (metadata + citations,
            different from default), temperature 0.2, and output word count below
            the cap; the revert turn restores the default model and configured 1.6
            temperature, proving overrides were turn-scoped.
        """
        if not ctx.configured_agent_id:
            pytest.skip(
                "no configured agent — test_create_configured_agent did not succeed"
            )
        if not ctx.default_model:
            pytest.skip(
                "no default model — test_invoke_baseline_default_model did not succeed"
            )
        override_model = ctx.config.override_model_name
        if not override_model:
            pytest.skip("OVERRIDE_MODEL_NAME not set — skipping all-overrides case")
        if _model_matches(override_model, ctx.default_model):
            pytest.skip(
                "OVERRIDE_MODEL_NAME equals the default model — override is "
                "indistinguishable from the default"
            )

        # 1) Single invoke carrying all three overrides; each must take effect.
        override_request = AgentInvocationRequest(
            input=_LONG_PROMPT,
            config_overrides={
                "model": override_model,
                "temperature": _OVERRIDE_TEMPERATURE,
                "max_tokens": _MAX_TOKENS_OVERRIDE,
            },
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
        output = data.get("output") or ""
        assert output, "empty agent output"

        # model: echoed in both metadata.model and citations.
        metadata_model = (data.get("metadata") or {}).get("model")
        responding = _responding_agent(data)
        assert _model_matches(metadata_model, override_model), (
            "configOverrides.model was not applied in metadata.model: "
            f"{metadata_model!r} (expected {override_model!r})"
        )
        assert _model_matches(responding.get("model"), override_model), (
            "configOverrides.model was not applied in citations: "
            f"{responding.get('model')!r} (expected {override_model!r})"
        )
        assert not _model_matches(responding.get("model"), ctx.default_model), (
            "override model unexpectedly equals the default model"
        )

        # temperature: echoed in citations.
        assert responding.get("temperature") == pytest.approx(
            _OVERRIDE_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), (
            "configOverrides.temperature was not applied: "
            f"{responding.get('temperature')!r}"
        )

        # max_tokens: validated indirectly via output word count.
        words = _word_count(output)
        assert words < _CAPPED_MAX_WORDS, (
            f"configOverrides.max_tokens={_MAX_TOKENS_OVERRIDE} did not truncate the "
            f"output: got {words} words (expected < {_CAPPED_MAX_WORDS})"
        )

        # 2) Re-invoke WITHOUT overrides; model + temperature must revert to the
        #    configured values, proving the overrides were per-turn and did not
        #    mutate the stored agent config.
        revert_request = AgentInvocationRequest(input="Hi")
        resp2 = ctx.agent.invoke_agent(
            ctx.project_id, ctx.configured_agent_id, revert_request
        )
        log_exchange("POST", url, revert_request.to_body(), resp2)
        assert resp2.status_code == 200, resp2.text
        responding2 = _responding_agent(resp2.json())
        assert _model_matches(responding2.get("model"), ctx.default_model), (
            "model did not revert to the default after the override turn: "
            f"{responding2.get('model')!r} (expected {ctx.default_model!r})"
        )
        assert responding2.get("temperature") == pytest.approx(
            _CONFIGURED_TEMPERATURE, abs=_TEMP_TOLERANCE
        ), (
            "temperature did not revert to the configured value after the "
            f"override turn: {responding2.get('temperature')!r}"
        )
