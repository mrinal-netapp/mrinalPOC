"""Shared before-class provisioning helpers for the agent-service suites.

Each agent-service suite needs a project and a model in place before its tests
run. These helpers centralize that setup so every suite fixture can reuse the
same logic:

- ``provision_project``: reuse ``PROJECT_ID`` or create a project and wait until
  its identity workflow finishes (``wait_for_project_ready``) so downstream
  create calls do not race the async project-init and 409.
- ``provision_model``: reuse ``LLM_MODEL_ID`` or create an Azure OpenAI credential
  (from ``AZURE_OPENAI_*``) plus the ``$LLM_MODEL_NAME`` deployment.

Env-provided ids are never tracked for cleanup, so only suite-created resources
are torn down.
"""

from __future__ import annotations

from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.resources import SuiteResources


def provision_project(
    config_client: ConfigServiceClient,
    config: AgentServiceConfig,
    resources: SuiteResources,
    *,
    name_prefix: str,
    source: str,
    timeout_sec: int = 60,
    poll_interval_sec: int = 5,
) -> tuple[str, str]:
    """Reuse ``PROJECT_ID`` or create + readiness-gate a project.

    Input:
        config_client: The config-service client.
        config: The resolved agent-service suite configuration.
        resources: The suite resource tracker for teardown.
        name_prefix: Prefix passed to ``unique_name`` for the project name.
        source: Value stored under the project ``metadata.source`` field.
        timeout_sec: Max seconds to wait for project readiness.
        poll_interval_sec: Seconds between readiness polls.

    Output:
        tuple[str, str]: The project id and name. When reusing ``PROJECT_ID``,
        the name is empty (not fetched) and the project is not tracked for
        cleanup.
    """
    if config.project_id:
        log.info(f"  [setup] reusing project from PROJECT_ID env: {config.project_id}")
        return config.project_id, ""
    name = unique_name(name_prefix)
    metadata = {"source": source}
    url = f"{config.config_service_url}/api/v1/projects"
    resp = config_client.create_project(name, metadata=metadata)
    log_exchange("POST", url, {"name": name, "metadata": metadata}, resp)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    project_id = data["id"]
    assert project_id, "project id missing in response"
    # Register for cleanup before the readiness wait so a timeout still tears the
    # project down.
    resources.add_project(project_id)
    # POST /projects returns before the project-init workflow finishes; poll
    # until identity setup completes so downstream create calls don't 409.
    wait_for_project_ready(
        config_client, project_id, timeout_sec=timeout_sec, poll_interval_sec=poll_interval_sec
    )
    return project_id, data.get("name", name)


def provision_model(
    config_client: ConfigServiceClient,
    config: AgentServiceConfig,
    resources: SuiteResources,
    project_id: str,
) -> str:
    """Reuse ``LLM_MODEL_ID`` or create an Azure credential + LLM model.

    Input:
        config_client: The config-service client.
        config: The resolved agent-service suite configuration.
        resources: The suite resource tracker for teardown.
        project_id: The project the model is registered under.

    Output:
        str: The model id. When reusing ``LLM_MODEL_ID``, the model (and its
        credential) are not tracked for cleanup.
    """
    if config.model_id:
        log.info(f"  [setup] reusing model from LLM_MODEL_ID env: {config.model_id}")
        return config.model_id
    provisioner = ModelProvisioner(config_client, on_exchange=log_exchange)
    cred_id = provisioner.add_azure_openai_credentials(project_id)
    resources.add_credential(cred_id, project_id)
    model_id = provisioner.add_llm_models(project_id, cred_id)
    resources.add_model(model_id, project_id)
    return model_id
