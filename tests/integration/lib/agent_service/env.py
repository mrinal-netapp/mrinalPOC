"""Agent-service suite configuration loaded from tests/integration/.env.local.

`load_env()` is the suite-level entrypoint: it loads the integration `.env.local`
(reusing `load_env_file` from `lib.common.settings`) and any already-exported
environment variables, then exposes the agent-service values as a single
`AgentServiceConfig` object for use across the suite.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from lib.common.settings import load_env_file


def _strip(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().strip('"').strip("'")


def _derive_root(api_base_url: str) -> str:
    """Return the gateway root for `API_BASE_URL` (the `/config` base).

    Strips a trailing `/config` (config-service's edge prefix) so sibling
    service prefixes can be appended; any other base is used as-is.
    """
    base = api_base_url.rstrip("/")
    return base[: -len("/config")] if base.endswith("/config") else base


@dataclass(frozen=True)
class ModelSpec:
    """Model identity/config used by the agent-service suites.

    This describes the model name/provider/providerModelId. If the selected provider
    requires credentials (e.g. `azure`), the suites provision a credential separately
    (see `lib.config_service.model.ModelProvisioner`) and register the model with a
    `credentialId`.
    """

    name: str
    provider: str
    provider_model_id: str
    model_type: str = "llm"
    model_class: str = "balanced"

    def to_create_body(self) -> dict[str, str]:
        """Serialize the model spec into a config-service create body.

        Function use:
            Builds the JSON payload used to register this model with the
            config-service.

        Input:
            None

        Output:
            dict[str, str]: The model-create request body.
        """
        return {
            "name": self.name,
            "provider": self.provider,
            "providerModelId": self.provider_model_id,
            "modelType": self.model_type,
            "modelClass": self.model_class,
        }


@dataclass(frozen=True)
class AgentServiceConfig:
    """Resolved agent-service suite configuration."""

    agent_service_url: str
    config_service_url: str
    model: ModelSpec
    # Optional overrides: when set, the suites reuse an existing project/model
    # instead of creating one (and skip deleting it in teardown).
    project_id: str = ""
    model_id: str = ""
    # Optional reuse of an existing Azure OpenAI credential (instantiation
    # suite). When set and healthy, the suite reuses it instead of creating a
    # new one (and skips deleting it in teardown).
    azure_openai_cred_id: str = ""
    # Pre-provisioned, indexed insurance knowledge base id for the retrieval
    # suite.
    insurance_kb_id: str = ""
    # Pre-provisioned, indexed GCNV knowledge base id for the retrieval suite.
    gcnv_kb_id: str = ""
    # Gateway model id used as the per-invoke `configOverrides.model` target by
    # the overrides suite. When empty, the model-override cases are skipped.
    override_model_name: str = ""
    # Pre-registered MCP server id for the MCP tool-call suite. When empty,
    # the MCP agent-creation step is skipped.
    weather_mcp_id: str = ""
    # Pre-registered managed GCNV MCP server id for the GCNV MCP tool-call
    # suite. When empty, the GCNV MCP agent-creation step is skipped.
    gcnv_mcp_server_id: str = ""
    # Default GCP project id injected into the GCNV agent's system prompt and
    # invoke query. When empty, the agent falls back to the project configured
    # on the GCNV MCP server.
    gcnv_gcp_project_id: str = ""
    # Remote weather MCP endpoint for the remote MCP tools suite
    # (suites/tools/remote). When empty, the remote no-auth suite is skipped.
    weather_mcp_server_url: str = ""
    # Transport for the remote weather MCP server (http / sse / streamable-http);
    # defaults to streamable-http.
    weather_mcp_connection_type: str = "streamable-http"
    # Remote wikipedia MCP endpoint for the API-key remote MCP tools suite
    # (suites/tools/remote). When empty, the with-auth suite is skipped.
    wikipedia_mcp_server_url: str = ""
    # Transport for the remote wikipedia MCP server; defaults to streamable-http.
    wikipedia_mcp_connection_type: str = "streamable-http"
    # API key sent as the ``x-api-key`` header to the remote wikipedia MCP.
    # When empty, the with-auth suite is skipped.
    wikipedia_mcp_api_key: str = ""

    def is_configured(self) -> bool:
        """True when both service base URLs are present.

        Function use:
            Lets suites decide whether to run or skip based on whether the
            required service URLs were resolved.

        Input:
            None

        Output:
            bool: ``True`` when both base URLs are set.
        """
        return bool(self.agent_service_url and self.config_service_url)

    def missing_keys(self) -> list[str]:
        """List the env var names that are required but unset.

        Function use:
            Produces an actionable list of missing configuration keys for
            skip/abort messages.

        Input:
            None

        Output:
            list[str]: Names of the missing required env vars.
        """
        missing = []
        if not self.agent_service_url:
            missing.append("AGENT_SERVICE_URL")
        if not self.config_service_url:
            missing.append("CONFIG_SERVICE_URL")
        return missing

    @property
    def models(self) -> list[ModelSpec]:
        """The configured models as a list.

        Function use:
            Exposes the single configured model as a list for callers that
            iterate over models.

        Input:
            None

        Output:
            list[ModelSpec]: A one-element list with the configured model.
        """
        return [self.model]


def _model_from_env(prefix: str, default: ModelSpec) -> ModelSpec:
    """Build a ModelSpec, allowing per-field overrides via env.

    Override keys: `{prefix}_MODEL_NAME`, `{prefix}_MODEL_PROVIDER`,
    `{prefix}_MODEL_PROVIDER_MODEL_ID`, `{prefix}_MODEL_TYPE`,
    `{prefix}_MODEL_CLASS`.
    """
    return ModelSpec(
        name=_strip(os.environ.get(f"{prefix}_MODEL_NAME")) or default.name,
        provider=_strip(os.environ.get(f"{prefix}_MODEL_PROVIDER")) or default.provider,
        provider_model_id=(
            _strip(os.environ.get(f"{prefix}_MODEL_PROVIDER_MODEL_ID"))
            or default.provider_model_id
        ),
        model_type=_strip(os.environ.get(f"{prefix}_MODEL_TYPE")) or default.model_type,
        model_class=_strip(os.environ.get(f"{prefix}_MODEL_CLASS")) or default.model_class,
    )


# The suite uses a single model. `provider` must be one of the config-service
# enum values [openai, openai_compatible, aws_bedrock, azure, google, local].
_DEFAULT_MODEL = ModelSpec(
    name="gpt-4o-mini",
    provider="azure",
    provider_model_id="gpt-4o-mini",
    model_type="llm",
    model_class="balanced",
)


def load_env() -> AgentServiceConfig:
    """Load `.env.local` + process env and return the agent-service config.

    Function use:
        Reads `AGENT_SERVICE_URL` and `CONFIG_SERVICE_URL` plus optional model
        overrides, and the optional `PROJECT_ID` / `LLM_MODEL_ID` overrides used
        to reuse an existing project/model. When either service URL is unset it is
        derived from `API_BASE_URL` (the `/config` base): the root becomes
        `{root}/agents-maf` for the agent-service and `{root}/config` for the
        config-service. `OVERRIDE_MODEL_NAME` supplies the gateway model id for
        the overrides suite's per-invoke model override. Does not raise on
        missing values; callers use `AgentServiceConfig.is_configured()` to
        decide whether to skip.

    Input:
        None

    Output:
        AgentServiceConfig: The resolved agent-service suite configuration.
    """
    load_env_file()
    api_base = _strip(os.environ.get("API_BASE_URL")).rstrip("/")
    root = _derive_root(api_base) if api_base else ""
    agent_service_url = _strip(os.environ.get("AGENT_SERVICE_URL")).rstrip("/")
    config_service_url = _strip(os.environ.get("CONFIG_SERVICE_URL")).rstrip("/")
    if not agent_service_url and root:
        agent_service_url = f"{root}/agents-maf"
    if not config_service_url and root:
        config_service_url = f"{root}/config"
    return AgentServiceConfig(
        agent_service_url=agent_service_url,
        config_service_url=config_service_url,
        model=_model_from_env("AGENT", _DEFAULT_MODEL),
        project_id=_strip(os.environ.get("PROJECT_ID")),
        model_id=_strip(os.environ.get("LLM_MODEL_ID")),
        azure_openai_cred_id=_strip(os.environ.get("AZURE_OPENAI_CRED_ID")),
        insurance_kb_id=_strip(os.environ.get("INSURANCE_KB_ID")),
        gcnv_kb_id=_strip(os.environ.get("GCNV_KB_ID")),
        override_model_name=_strip(os.environ.get("OVERRIDE_MODEL_NAME")),
        weather_mcp_id=_strip(os.environ.get("WEATHER_MCP_ID")),
        gcnv_mcp_server_id=_strip(os.environ.get("GCNV_MCP_SERVER_ID")),
        gcnv_gcp_project_id=_strip(os.environ.get("GCNV_GCP_PROJECT_ID")),
        weather_mcp_server_url=_strip(os.environ.get("WEATHER_MCP_SERVER_URL")),
        weather_mcp_connection_type=(
            _strip(os.environ.get("WEATHER_MCP_CONNECTION_TYPE")) or "streamable-http"
        ),
        wikipedia_mcp_server_url=_strip(os.environ.get("WIKIPEDIA_MCP_SERVER_URL")),
        wikipedia_mcp_connection_type=(
            _strip(os.environ.get("WIKIPEDIA_MCP_CONNECTION_TYPE")) or "streamable-http"
        ),
        wikipedia_mcp_api_key=_strip(os.environ.get("WIKIPEDIA_MCP_API_KEY")),
    )
