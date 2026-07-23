"""Agent-service instantiation suite — single-agent flow.

Chained end-to-end flow against a live deployment:

    project -> credential -> model -> agent -> invoke -> update -> re-invoke

The suite uses a single model (`azure/gpt-4o-mini`). Provisioning uses
config-service (`ConfigServiceClient`); invokes use agent-service
(`AgentServiceClient`). State flows between the ordered methods through a
single class-scoped `InstantiationAgentContext`.

Unlike the other agent-service suites, this suite provisions its prerequisites
as first-class, ordered test cases rather than silently in the class fixture:

    - ``test_create_and_validate_project`` — reuse ``PROJECT_ID`` when set and
      healthy, otherwise create a project and poll until it is ready.
    - ``test_add_and_validate_azure_openai_cred`` — reuse ``AZURE_OPENAI_CRED_ID``
      when set and healthy, otherwise create an Azure OpenAI credential from the
      ``AZURE_OPENAI_*`` env vars and validate it.
    - ``test_add_and_validate_model`` — reuse ``LLM_MODEL_ID`` when set,
      otherwise register a model against the credential and validate it.

The rest of the file covers the agent half of the instantiation flow (create +
invoke + the temperature cache-bypass scenario across the default and
`staging=playground` paths, sync and SSE). The team half lives in the sibling
`test_instantiation_team.py`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.agent_service.streaming import EVENT_STARTED, StreamResult
from lib.common.logger import log, log_exchange, log_stream
from lib.common.platform_client import unique_name
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.common.settings import IntegrationSettings
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.resources import SuiteResources

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.instantiation,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Agent identity fields reused across the create (POST) and update (PUT)
# bodies — both send a full agent definition, so only the temperature under
# test changes between calls.
AGENT_ROLE = "assistant"
AGENT_SYSTEM_PROMPT = "You are a helpful assistant."

# Temperatures threaded through the staging-flag cache-bypass scenario:
# create at 0.7, update to 0.8 (seen only via playground), update to 0.9.
AGENT_TEMP_INITIAL = 0.7
AGENT_TEMP_UPDATED = 0.8
AGENT_TEMP_FINAL = 0.9

# Query params that opt an invoke into the playground staging path, which
# bypasses agent-service's bundle + config caches and reads config-service
# fresh on every request.
PLAYGROUND_PARAMS = {"staging": "playground"}

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-instantiation"
PROJECT_SOURCE = "pytest-agent-instantiation"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


@dataclass
class InstantiationAgentContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    project_name: str = ""
    credential_id: str = ""
    model_ids: list[str] = field(default_factory=list)
    agent_id: str = ""
    agent_name: str = ""
    session_id: str | None = None
    resources: SuiteResources = field(default_factory=SuiteResources)


def _stream_invoke_response(result: StreamResult) -> dict[str, Any]:
    """Validate an SSE stream end-to-end and return its ``invokeResponse``.

    Asserts the streaming contract — HTTP 200, ``text/event-stream``
    content-type, a leading ``started`` event, non-empty concatenated token
    text, no ``error`` event, and a terminal ``completed`` event — then returns
    the decoded ``completed.metadata.invokeResponse`` envelope. That envelope
    matches REST sync for ``citations``, so agent streaming tests assert
    temperature exactly as their sync siblings do.
    """
    assert result.status_code == 200, result.raw_non_sse_body or "non-200 stream"
    content_type = result.headers.get("content-type", "")
    assert content_type.startswith("text/event-stream"), (
        f"unexpected content-type: {content_type!r}"
    )
    assert result.events, "no SSE events received"
    assert result.events[0].event == EVENT_STARTED, (
        f"first event was {result.events[0].event!r}, expected {EVENT_STARTED!r}"
    )
    assert result.error_event is None, f"stream emitted error: {result.error_event}"
    assert result.text, "no streamed token text"
    completed = result.completed_event
    assert completed is not None, "no terminal 'completed' event"
    parsed = completed.data_json
    assert isinstance(parsed, dict), "completed event data is not JSON"
    metadata = parsed.get("metadata")
    assert isinstance(metadata, dict), "completed event missing metadata"
    invoke_response = metadata.get("invokeResponse")
    assert isinstance(invoke_response, dict), (
        "completed.metadata.invokeResponse missing or malformed"
    )
    return invoke_response


class TestInstantiationAgent:
    """Ordered single-agent instantiation flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> InstantiationAgentContext:
        """Before/after class: build clients and, after class, run cleanup.

        Unlike the other agent-service suites, this fixture does NOT provision
        the project/credential/model. Those are created and validated by the
        first three ordered test cases so the provisioning flow itself is
        asserted. The fixture only wires up the clients and the shared context;
        the ordered tests populate ``project_id`` / ``credential_id`` /
        ``model_ids`` on it.

        Env-provided ids are never tracked for cleanup, so only suite-created
        resources are torn down.
        """
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = InstantiationAgentContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )

        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: InstantiationAgentContext) -> None:
        """Reuse a healthy ``PROJECT_ID`` or create + readiness-gate a project.

        Test scenario:
            When ``PROJECT_ID`` is set, probe the project's service-account
            endpoint: a ``200`` means it is fully initialized, so reuse it (and
            do not track it for cleanup). When ``PROJECT_ID`` is unset or the
            probe is not ``200`` (project missing or not ready), create a fresh
            project, register it for teardown, and poll
            ``wait_for_project_ready`` until identity setup completes.

        Validation we are covering:
            A reused project must answer the service-account probe with ``200``.
            A created project must return ``201`` with a non-empty id and then
            reach the ready state before downstream create calls run.
        """
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
        # Register for cleanup before the readiness wait so a timeout still tears
        # the project down.
        ctx.resources.add_project(project_id)
        wait_for_project_ready(
            ctx.config_client,
            project_id,
            timeout_sec=PROJECT_READY_TIMEOUT_SEC,
            poll_interval_sec=PROJECT_READY_POLL_SEC,
        )
        ctx.project_id = project_id
        ctx.project_name = data.get("name", name)

    def test_add_and_validate_azure_openai_cred(
        self, ctx: InstantiationAgentContext
    ) -> None:
        """Reuse a healthy ``AZURE_OPENAI_CRED_ID`` or create + validate a cred.

        Test scenario:
            Skips if no project exists. When ``AZURE_OPENAI_CRED_ID`` is set,
            fetch it: a ``200`` means it is usable, so reuse it (and do not
            track it for cleanup). When it is unset or the fetch is not ``200``,
            create a fresh Azure OpenAI credential from ``AZURE_OPENAI_API_KEY``
            / ``AZURE_OPENAI_ENDPOINT`` / ``AZURE_OPENAI_API_VERSION`` and
            register it for teardown.

        Validation we are covering:
            A reused credential must answer the get-credential probe with
            ``200``. A created credential returns a non-empty id (the
            provisioner asserts ``201``) which is re-fetched and asserted
            ``200`` with a matching ``id`` and ``provider`` of ``azure``.
        """
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
        # Validate the freshly created credential is fetchable.
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

    def test_add_and_validate_model(self, ctx: InstantiationAgentContext) -> None:
        """Reuse ``LLM_MODEL_ID`` or register + validate a model on the credential.

        Test scenario:
            Skips if no project exists. When ``LLM_MODEL_ID`` is set, reuse it
            (and do not track it for cleanup). Otherwise, skip when no
            credential is available, then register the ``$LLM_MODEL_NAME``
            deployment against the provisioned credential and register the model
            for teardown.

        Validation we are covering:
            A created model returns a non-empty, UUID-shaped id (the provisioner
            asserts ``201``); the id is stored on the context for the agent
            tests. A reused ``LLM_MODEL_ID`` is threaded through unchanged.
        """
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

    def test_create_agent(self, ctx: InstantiationAgentContext) -> None:
        """Create an assistant agent bound to the provisioned model.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` (role
            ``assistant``, helpful-assistant system prompt) to config-service
            and stores the returned agent id on the context.

        Validation we are covering:
            Asserts HTTP 201, that the agent id matches the ``ag-xxxxxxxx``
            pattern, that the echoed ``modelId`` and ``role`` match what was
            requested, and that the echoed ``temperature`` is ``0.7``.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_and_validate_model did not succeed")
        ctx.agent_name = unique_name("e2e-agent")
        request = AgentCreationRequest(
            name=ctx.agent_name,
            role=AGENT_ROLE,
            system_prompt=AGENT_SYSTEM_PROMPT,
            model_id=ctx.model_ids[0],
            temperature=AGENT_TEMP_INITIAL,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id), f"unexpected agent id: {ctx.agent_id!r}"
        assert data.get("modelId") == ctx.model_ids[0]
        assert data.get("role") == AGENT_ROLE
        assert data.get("temperature") == pytest.approx(AGENT_TEMP_INITIAL)
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_invoke_agent(self, ctx: InstantiationAgentContext) -> None:
        """Invoke the agent once (default path) and capture the session id.

        Test scenario:
            Skips if no agent exists. POSTs a fixed prompt to the agent-service
            invoke endpoint with no ``staging`` query param and records the
            response ``sessionId`` for reuse on the follow-up invoke. This first
            default invoke is what populates agent-service's in-process bundle
            cache with the freshly created agent (temperature ``0.7``).

        Validation we are covering:
            Asserts HTTP 200, that the response ``output`` is non-empty, that a
            ``durationMs`` field is present, and that the citation
            ``temperature`` echoes the created value (``0.7``).
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: INSTANTIATION_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        assert "durationMs" in data
        responding = (data.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_INITIAL)
        ctx.session_id = data.get("sessionId")

    def test_invoke_agent_stream(self, ctx: InstantiationAgentContext) -> None:
        """Stream the agent invoke (default path); same contract as sync.

        Test scenario:
            Skips if no agent exists. Streams the same fixed prompt to the
            agent's ``/invoke/stream`` endpoint with no ``staging`` query param.
            The bundle cache is already warm from the sync invoke above, so the
            streamed envelope must echo the created temperature (``0.7``).

        Validation we are covering:
            Via ``_stream_invoke_response``: the full SSE contract holds, and the
            decoded ``invokeResponse`` citation ``temperature`` is ``0.7``.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: INSTANTIATION_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/stream"
        )
        result = ctx.agent.invoke_agent_stream(ctx.project_id, ctx.agent_id, body)
        log_stream("POST", url, body, result)
        invoke_response = _stream_invoke_response(result)
        responding = (invoke_response.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_INITIAL)

    def test_update_agent_configuration(self, ctx: InstantiationAgentContext) -> None:
        """Update the agent's temperature to ``0.8`` via config-service.

        Test scenario:
            Skips if no agent exists. Issues a full-body ``PUT`` to
            config-service changing the temperature from ``0.7`` to ``0.8``.
            Config-service does not notify agent-service, so agent-service keeps
            serving the cached bundle on the default path.

        Validation we are covering:
            Asserts HTTP 200 and that the echoed ``temperature`` is ``0.8``.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        request = AgentCreationRequest(
            name=ctx.agent_name,
            role=AGENT_ROLE,
            system_prompt=AGENT_SYSTEM_PROMPT,
            model_id=ctx.model_ids[0],
            temperature=AGENT_TEMP_UPDATED,
        )
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}"
        )
        resp = ctx.config_client.update_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("PUT", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("temperature") == pytest.approx(AGENT_TEMP_UPDATED)

    def test_invoke_agent_again(self, ctx: InstantiationAgentContext) -> None:
        """Re-invoke on the default path; the cached temperature must persist.

        Test scenario:
            Skips if no agent exists. POSTs a second prompt to the default
            invoke endpoint (no ``staging``), reusing the prior ``sessionId``
            when available, after the config-service temperature was changed to
            ``0.8``.

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, and that the citation
            ``temperature`` is still ``0.7`` — proving the default path serves
            the cached bundle and did not pick up the config-service change.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body: dict[str, object] = {"input": "What is 2 + 2? Reply with only the number."}
        if ctx.session_id:
            body["sessionId"] = ctx.session_id
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        responding = (data.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_INITIAL)

    def test_invoke_agent_again_stream(self, ctx: InstantiationAgentContext) -> None:
        """Re-stream on the default path; the cached temperature must persist.

        Test scenario:
            Skips if no agent exists. Streams a second prompt to the default
            ``/invoke/stream`` endpoint (no ``staging``), reusing the prior
            ``sessionId`` when available, after config-service was changed to
            ``0.8``.

        Validation we are covering:
            Via ``_stream_invoke_response``: the SSE contract holds, and the
            citation ``temperature`` is still ``0.7`` — the default streaming
            path serves the same cached bundle as sync.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body: dict[str, object] = {"input": "What is 2 + 2? Reply with only the number."}
        if ctx.session_id:
            body["sessionId"] = ctx.session_id
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/stream"
        )
        result = ctx.agent.invoke_agent_stream(ctx.project_id, ctx.agent_id, body)
        log_stream("POST", url, body, result)
        invoke_response = _stream_invoke_response(result)
        responding = (invoke_response.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_INITIAL)

    def test_invoke_agent_from_playground(self, ctx: InstantiationAgentContext) -> None:
        """Invoke with ``staging=playground``; the fresh temperature must show.

        Test scenario:
            Skips if no agent exists. Invokes the agent with the
            ``staging=playground`` query param, which bypasses agent-service's
            bundle cache and config TTL caches and reads the agent fresh from
            config-service (now temperature ``0.8``).

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, and that the citation
            ``temperature`` is ``0.8`` — proving playground bypasses the cache.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: PLAYGROUND_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke?staging=playground"
        )
        resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.agent_id, body, params=PLAYGROUND_PARAMS
        )
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        responding = (data.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_UPDATED)

    def test_invoke_agent_from_playground_stream(
        self, ctx: InstantiationAgentContext
    ) -> None:
        """Stream with ``staging=playground``; the fresh temperature must show.

        Test scenario:
            Skips if no agent exists. Streams to the agent's ``/invoke/stream``
            endpoint with the ``staging=playground`` query param, which bypasses
            the bundle + config caches and reads the agent fresh from
            config-service (now temperature ``0.8``).

        Validation we are covering:
            Via ``_stream_invoke_response``: the SSE contract holds, and the
            citation ``temperature`` is ``0.8`` — playground bypasses the cache
            on the streaming path too.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: PLAYGROUND_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/stream?staging=playground"
        )
        result = ctx.agent.invoke_agent_stream(
            ctx.project_id, ctx.agent_id, body, params=PLAYGROUND_PARAMS
        )
        log_stream("POST", url, body, result)
        invoke_response = _stream_invoke_response(result)
        responding = (invoke_response.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_UPDATED)

    def test_update_agent_configuration_again(
        self, ctx: InstantiationAgentContext
    ) -> None:
        """Update the agent's temperature again to ``0.9`` via config-service.

        Test scenario:
            Skips if no agent exists. Issues a second full-body ``PUT`` to
            config-service changing the temperature from ``0.8`` to ``0.9``.

        Validation we are covering:
            Asserts HTTP 200 and that the echoed ``temperature`` is ``0.9``.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        request = AgentCreationRequest(
            name=ctx.agent_name,
            role=AGENT_ROLE,
            system_prompt=AGENT_SYSTEM_PROMPT,
            model_id=ctx.model_ids[0],
            temperature=AGENT_TEMP_FINAL,
        )
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}"
        )
        resp = ctx.config_client.update_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("PUT", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("temperature") == pytest.approx(AGENT_TEMP_FINAL)

    def test_invoke_agent_again_from_playground(
        self, ctx: InstantiationAgentContext
    ) -> None:
        """Invoke with ``staging=playground`` again; the latest temp must show.

        Test scenario:
            Skips if no agent exists. Invokes the agent again with the
            ``staging=playground`` query param after the temperature was changed
            to ``0.9``; playground re-reads config-service fresh on every call.

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, and that the citation
            ``temperature`` is ``0.9`` — proving each playground invoke reflects
            the current config-service state.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: PLAYGROUND_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke?staging=playground"
        )
        resp = ctx.agent.invoke_agent(
            ctx.project_id, ctx.agent_id, body, params=PLAYGROUND_PARAMS
        )
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        responding = (data.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_FINAL)

    def test_invoke_agent_again_from_playground_stream(
        self, ctx: InstantiationAgentContext
    ) -> None:
        """Stream with ``staging=playground`` again; the latest temp must show.

        Test scenario:
            Skips if no agent exists. Streams again with the ``staging=playground``
            query param after the temperature was changed to ``0.9``; playground
            re-reads config-service fresh on every streamed call too.

        Validation we are covering:
            Via ``_stream_invoke_response``: the SSE contract holds, and the
            citation ``temperature`` is ``0.9``.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: PLAYGROUND_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/stream?staging=playground"
        )
        result = ctx.agent.invoke_agent_stream(
            ctx.project_id, ctx.agent_id, body, params=PLAYGROUND_PARAMS
        )
        log_stream("POST", url, body, result)
        invoke_response = _stream_invoke_response(result)
        responding = (invoke_response.get("citations") or {}).get("respondingAgent") or {}
        assert responding.get("temperature") == pytest.approx(AGENT_TEMP_FINAL)
