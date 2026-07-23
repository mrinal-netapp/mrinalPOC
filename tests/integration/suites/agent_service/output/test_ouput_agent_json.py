"""Agent-service structured-output suite.

Chained end-to-end flow against a live deployment:

    project -> model -> {simple | complex | invalid} structured-output agent
            -> get agent (verify structuredOutput echoed)
            -> invoke -> validate the output against the JSON Schema

Agents are created with the structured-output contract
``structuredOutput: { enabled, responseFormat: "json_object", outputSchema }``
where ``outputSchema`` is the JSON Schema serialized as a string.

Provisioning uses config-service (`ConfigServiceClient`); invokes use
agent-service (`AgentServiceClient`). State flows between the ordered methods
through a single class-scoped `OutputAgentContext`.

Three agents are exercised, each with a generic system prompt:

* simple schema  -> `parsedOutput` matches a flat object schema
* complex schema -> `parsedOutput` matches a nested object schema
* invalid schema -> a non-object-root schema config-service accepts (it does
  not parse ``outputSchema``) but agent-service drops, so the invoke returns
  plain text and `parsedOutput` is ``None``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.agent_service.validation import assert_output_matches_schema
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.resources import SuiteResources

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.structured_output,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-structured-output"
PROJECT_SOURCE = "pytest-agent-structured-output"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

AGENT_ROLE = "assistant"
# Deliberately generic so the schema (not the prompt) drives the output shape.
AGENT_SYSTEM_PROMPT = "You are a helpful assistant. Answer clearly and accurately."

# Flat object schema: one required string plus an optional string.
SIMPLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "title": "SimpleAnswer",
    "properties": {
        "answer": {"type": "string"},
        "confidence": {"type": "string"},
    },
    "required": ["answer"],
}

# Nested object schema: arrays of objects plus a nested metadata object.
COMPLEX_SCHEMA: dict[str, Any] = {
    "type": "object",
    "title": "ResearchReport",
    "properties": {
        "summary": {"type": "string"},
        "topic": {"type": "string"},
        "confidence": {"type": "string"},
        "keyFindings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "importance": {"type": "integer"},
                },
                "required": ["title", "detail"],
            },
        },
        "sources": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "url": {"type": "string"},
                },
                "required": ["name"],
            },
        },
        "metadata": {
            "type": "object",
            "properties": {
                "generatedBy": {"type": "string"},
                "wordCount": {"type": "integer"},
            },
            "required": ["generatedBy"],
        },
    },
    "required": ["summary", "topic", "confidence", "keyFindings"],
}

# Non-object root: sent as a serialized string in ``outputSchema`` with
# ``responseFormat: "json_object"``. config-service stores it (it does not
# parse the string), but agent-service's outcome-model builder rejects the
# non-object root, so no provider response_format is wired and the invoke
# returns plain text with a null parsedOutput.
INVALID_SCHEMA: dict[str, Any] = {"type": "string"}


@dataclass
class OutputAgentContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    project_name: str = ""
    credential_id: str = ""
    model_ids: list[str] = field(default_factory=list)
    simple_agent_id: str = ""
    complex_agent_id: str = ""
    invalid_agent_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _create_structured_agent(
    ctx: OutputAgentContext,
    *,
    name_prefix: str,
    schema: dict[str, Any],
) -> str:
    """Create a structured-output agent and return its id (asserts 201)."""
    name = unique_name(name_prefix)
    request = AgentCreationRequest(
        name=name,
        role=AGENT_ROLE,
        system_prompt=AGENT_SYSTEM_PROMPT,
        model_id=ctx.model_ids[0],
        structured_output={
            "enabled": True,
            "responseFormat": "json_object",
            "outputSchema": json.dumps(schema),
        },
    )
    url = ctx.config_client.agents_url(ctx.project_id)
    resp = ctx.config_client.create_agent(ctx.project_id, request)
    log_exchange("POST", url, request.to_body(), resp)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    agent_id = data["id"]
    assert AGENT_ID_RE.match(agent_id), f"unexpected agent id: {agent_id!r}"
    ctx.resources.add_agent(agent_id, ctx.project_id)
    return agent_id


def _structured_output_block(agent_json: dict[str, Any]) -> dict[str, Any]:
    """Return the ``structuredOutput`` block from an agent GET body."""
    block = agent_json.get("structuredOutput")
    assert isinstance(block, dict), f"missing structuredOutput block: {agent_json}"
    return block


class TestOutputAgentJson:
    """Ordered structured-output flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> OutputAgentContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = OutputAgentContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: OutputAgentContext) -> None:
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
        self, ctx: OutputAgentContext
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

    def test_add_and_validate_model(self, ctx: OutputAgentContext) -> None:
        """Reuse ``LLM_MODEL_ID`` or register + validate a model on the credential."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_and_validate_project did not succeed")

        env_model_id = ctx.config.model_id
        if env_model_id:
            log.info(f"  [setup] reusing model from LLM_MODEL_ID env: {env_model_id}")
            ctx.model_ids.append(env_model_id)
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
        ctx.model_ids.append(model_id)

    def test_create_simple_structured_agent(self, ctx: OutputAgentContext) -> None:
        """Create an agent with a simple (flat) structured-output schema.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` carrying
            ``structuredOutput`` with ``SIMPLE_SCHEMA`` and a generic system
            prompt.

        Validation we are covering:
            Asserts HTTP 201 and that the returned agent id matches the
            ``ag-xxxxxxxx`` pattern (checked inside the helper).
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        ctx.simple_agent_id = _create_structured_agent(
            ctx, name_prefix="e2e-simple-structured", schema=SIMPLE_SCHEMA
        )

    def test_simple_agent_details_has_structured_output(
        self, ctx: OutputAgentContext
    ) -> None:
        """GET the simple agent and verify its ``structuredOutput`` block.

        Test scenario:
            Skips if the simple agent was not created. GETs the agent from
            config-service.

        Validation we are covering:
            Asserts HTTP 200, that ``structuredOutput.enabled`` is truthy, that
            ``responseFormat`` is ``"json_object"``, and that the echoed
            ``outputSchema`` string parses back to ``SIMPLE_SCHEMA``.
        """
        if not ctx.simple_agent_id:
            pytest.skip("no simple agent — creation did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.simple_agent_id}"
        )
        resp = ctx.config_client.get_agent(ctx.project_id, ctx.simple_agent_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        block = _structured_output_block(resp.json())
        assert block.get("enabled"), f"structuredOutput not enabled: {block}"
        assert block.get("responseFormat") == "json_object"
        assert json.loads(block["outputSchema"]) == SIMPLE_SCHEMA

    def test_invoke_simple_agent_output_matches_schema(
        self, ctx: OutputAgentContext
    ) -> None:
        """Invoke the simple agent and validate ``parsedOutput`` against the schema.

        Test scenario:
            Skips if the simple agent was not created. POSTs a prompt to the
            agent-service invoke endpoint.

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, a non-null ``parsedOutput``,
            and that ``parsedOutput`` validates against ``SIMPLE_SCHEMA``.
        """
        if not ctx.simple_agent_id:
            pytest.skip("no simple agent — creation did not succeed")
        body = {"input": "In one sentence, what is the capital of France?"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.simple_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.simple_agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        parsed = data.get("parsedOutput")
        assert isinstance(parsed, dict), f"parsedOutput not a dict: {parsed!r}"
        assert_output_matches_schema(parsed, SIMPLE_SCHEMA)

    def test_create_complex_structured_agent(self, ctx: OutputAgentContext) -> None:
        """Create an agent with a complex (nested) structured-output schema.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` carrying
            ``structuredOutput`` with ``COMPLEX_SCHEMA`` and a generic system
            prompt.

        Validation we are covering:
            Asserts HTTP 201 and a valid ``ag-xxxxxxxx`` agent id (in helper).
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        ctx.complex_agent_id = _create_structured_agent(
            ctx, name_prefix="e2e-complex-structured", schema=COMPLEX_SCHEMA
        )

    def test_complex_agent_details_has_structured_output(
        self, ctx: OutputAgentContext
    ) -> None:
        """GET the complex agent and verify its ``structuredOutput`` block.

        Test scenario:
            Skips if the complex agent was not created. GETs the agent from
            config-service.

        Validation we are covering:
            Asserts HTTP 200, that ``structuredOutput.enabled`` is truthy, that
            ``responseFormat`` is ``"json_object"``, and that the echoed
            ``outputSchema`` string parses back to ``COMPLEX_SCHEMA``.
        """
        if not ctx.complex_agent_id:
            pytest.skip("no complex agent — creation did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.complex_agent_id}"
        )
        resp = ctx.config_client.get_agent(ctx.project_id, ctx.complex_agent_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        block = _structured_output_block(resp.json())
        assert block.get("enabled"), f"structuredOutput not enabled: {block}"
        assert block.get("responseFormat") == "json_object"
        assert json.loads(block["outputSchema"]) == COMPLEX_SCHEMA

    def test_invoke_complex_agent_output_matches_schema(
        self, ctx: OutputAgentContext
    ) -> None:
        """Invoke the complex agent and validate ``parsedOutput`` against the schema.

        Test scenario:
            Skips if the complex agent was not created. POSTs a research-style
            prompt to the agent-service invoke endpoint.

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, a non-null ``parsedOutput``,
            and that ``parsedOutput`` validates against ``COMPLEX_SCHEMA``
            (nested arrays/objects included).
        """
        if not ctx.complex_agent_id:
            pytest.skip("no complex agent — creation did not succeed")
        body = {"input": "Give me a short research report on renewable energy trends."}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.complex_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.complex_agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        parsed = data.get("parsedOutput")
        assert isinstance(parsed, dict), f"parsedOutput not a dict: {parsed!r}"
        assert_output_matches_schema(parsed, COMPLEX_SCHEMA)

    def test_create_invalid_structured_agent(self, ctx: OutputAgentContext) -> None:
        """Create an agent with an invalid (non-object-root) structured schema.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` carrying
            ``structuredOutput`` with ``INVALID_SCHEMA`` serialized into
            ``outputSchema`` (a non-object root that config-service stores as an
            opaque string but agent-service later drops).

        Validation we are covering:
            Asserts HTTP 201 — config-service accepts any non-empty
            ``outputSchema`` string at creation time (JSON-schema validity is
            checked downstream in agent-service).
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        ctx.invalid_agent_id = _create_structured_agent(
            ctx, name_prefix="e2e-invalid-structured", schema=INVALID_SCHEMA
        )

    def test_invoke_invalid_agent_returns_plain_text(
        self, ctx: OutputAgentContext
    ) -> None:
        """Invoke the invalid-schema agent; expect plain text and null parsedOutput.

        Test scenario:
            Skips if the invalid agent was not created. POSTs a prompt to the
            agent-service invoke endpoint.

        Validation we are covering:
            Asserts HTTP 200 and non-empty ``output``, and that ``parsedOutput``
            is ``None`` — proving agent-service dropped the unbuildable schema
            and did no structured parsing.
        """
        if not ctx.invalid_agent_id:
            pytest.skip("no invalid agent — creation did not succeed")
        body = {"input": "In one sentence, what is the capital of France?"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.invalid_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.invalid_agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        assert data.get("parsedOutput") is None, (
            f"expected null parsedOutput for invalid schema, got: {data.get('parsedOutput')!r}"
        )
