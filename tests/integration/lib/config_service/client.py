"""HTTP client for config-service provisioning (projects, models, agents, teams).

Contracts: Task 002 spec — Config-Service API (`CONFIG_SERVICE_URL`).
Paths are relative to the config-service base; request/response bodies are
camelCase JSON. Authentication is opt-in via ``ENABLE_AUTH_CONFIG_SERVICE``
(Keycloak ``password`` grant user token — config-service requires the ``email``
claim for project creation); when unset, calls are unauthenticated.
"""

from __future__ import annotations

from typing import Any

import httpx
import re

from lib.agent_service.env import AgentServiceConfig
from lib.authentication.keycloak_client import auth_enabled
from lib.common.auth import KeycloakAuth
from lib.common.settings import IntegrationSettings
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.credential_request import CredentialCreateRequest
from lib.models.evaluation_template_request import (
    EvaluationTemplateCreateRequest,
    EvaluationTemplateUpdateRequest,
)
from lib.models.managed_mcp_server_request import ManagedMcpServerRequest
from lib.models.remote_mcp_server_request import RemoteMcpServerRequest
from lib.models.team_creation_request import TeamCreationRequest


class ConfigServiceClient:
    """Config-service client for agent-service E2E provisioning."""

    def __init__(
        self,
        config: AgentServiceConfig,
        settings: IntegrationSettings,
    ) -> None:
        self._config = config
        self._base = config.config_service_url.rstrip("/")
        timeout = httpx.Timeout(120.0, connect=60.0)
        self._http = httpx.Client(
            verify=settings.verify_tls, timeout=timeout, trust_env=False
        )
        self._use_auth = auth_enabled("ENABLE_AUTH_CONFIG_SERVICE")
        # User-token (Keycloak password grant) auth. config-service requires a
        # user token (email claim) for project creation, so we authenticate as a
        # real realm user rather than a service account.
        self._keycloak = KeycloakAuth(settings) if self._use_auth else None

    def close(self) -> None:
        """Close the underlying HTTP and Keycloak clients.

        Function use:
            Releases network resources held by this client; call when the
            client is no longer needed (e.g. test teardown).

        Input:
            None

        Output:
            None
        """
        self._http.close()

    @staticmethod
    def project_prefix(project_id: str) -> str:
        """Build the relative config-service path prefix for a project.

        Function use:
            Produces the ``api/v1/projects/{projectId}`` path fragment used to
            compose project-scoped resource URLs.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            str: The relative path prefix for the given project.
        """
        return f"api/v1/projects/{project_id}"

    def _json_headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self._use_auth and self._keycloak is not None:
            token = self._keycloak.get_access_token(self._http)
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _raw_headers(self, content_type: str) -> dict[str, str]:
        """Headers for raw-body uploads (test-case JSONL/JSON)."""
        headers = {"Accept": "application/json", "Content-Type": content_type}
        if self._use_auth and self._keycloak is not None:
            token = self._keycloak.get_access_token(self._http)
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def probe(self, path: str) -> httpx.Response:
        """GET against ``{CONFIG_SERVICE_URL}/{path}`` (/health, /ready).

        Function use:
            Performs an unauthenticated GET health/readiness probe against the
            config-service base URL.

        Input:
            path (str): The path to probe, relative to the base URL.

        Output:
            httpx.Response: The raw HTTP response from the probe request.
        """
        url = f"{self._base}/{path.lstrip('/')}"
        return self._http.get(url, headers={"Accept": "application/json"})

    def create_project(
        self,
        name: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """``POST /api/v1/projects`` — create a project (expect ``201``).

        Function use:
            Creates a new config-service project, optionally attaching
            metadata; used to provision a project for E2E tests.

        Input:
            name (str): The project name.
            metadata (dict[str, Any] | None): Optional project metadata; omitted
                from the request body when ``None``.

        Output:
            httpx.Response: The raw HTTP response from the create-project call.
        """
        body: dict[str, Any] = {"name": name}
        if metadata is not None:
            body["metadata"] = metadata
        return self._http.post(
            f"{self._base}/api/v1/projects",
            headers=self._json_headers(),
            json=body,
        )

    def get_project_service_account(self, project_id: str) -> httpx.Response:
        """``GET /api/v1/projects/{projectId}/service-account`` — readiness probe.

        Function use:
            Fetches the project's per-project Keycloak service account. This is
            the last piece of state the project-init workflow provisions, so a
            ``200`` confirms the project is fully initialized (gateway +
            identity setup) and create-shaped calls (e.g. add-model) will no
            longer be rejected with ``409``. Returns ``404`` while the workflow
            is still provisioning.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            httpx.Response: The raw HTTP response from the service-account GET.
        """
        return self._http.get(
            f"{self._base}/{self.project_prefix(project_id)}/service-account",
            headers=self._json_headers(),
        )

    def models_url(self, project_id: str) -> str:
        """Build the absolute models collection URL for a project.

        Function use:
            Composes the full URL of the models endpoint for the given
            project.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            str: The absolute URL of the project's models collection.
        """
        return f"{self._base}/{self.project_prefix(project_id)}/models"

    def add_model(self, project_id: str, body: dict[str, Any]) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/models`` — register a model.

        Function use:
            Registers a model under the given project (expects ``201``).

        Input:
            project_id (str): The config-service project identifier.
            body (dict[str, Any]): The create-model request body (camelCase).

        Output:
            httpx.Response: The raw HTTP response from the add-model call.
        """
        return self._http.post(
            self.models_url(project_id),
            headers=self._json_headers(),
            json=body,
        )

    def credentials_url(self, project_id: str) -> str:
        """Build the absolute credentials collection URL for a project.

        Function use:
            Composes the full URL of the credentials endpoint for the given
            project.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            str: The absolute URL of the project's credentials collection.
        """
        return f"{self._base}/{self.project_prefix(project_id)}/credentials"

    @staticmethod
    def credential_body(
        *,
        name: str,
        provider: str,
        secret_data: dict[str, Any],
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        """Build a create-credential request body (camelCase).

        Function use:
            Assembles the request body for creating a credential, mapping
            inputs to the camelCase keys required by the config-service spec.

        Input:
            name (str): The credential name.
            provider (str): The provider identifier (e.g. ``azure``).
            secret_data (dict[str, Any]): The secret payload (e.g. api key).
            metadata (dict[str, Any]): Non-secret metadata for the credential.

        Output:
            dict[str, Any]: The create-credential request body.
        """
        return {
            "name": name,
            "provider": provider,
            "secretData": secret_data,
            "metadata": metadata,
        }

    def create_model_credential(
        self,
        project_id: str,
        *,
        name: str,
        provider: str,
        secret_data: dict[str, Any],
        metadata: dict[str, Any],
    ) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/credentials`` — create a credential.

        Function use:
            Creates a credential under the given project (expects ``201``).

        Input:
            project_id (str): The config-service project identifier.
            name (str): The credential name.
            provider (str): The provider identifier (e.g. ``azure``).
            secret_data (dict[str, Any]): The secret payload (e.g. api key).
            metadata (dict[str, Any]): Non-secret metadata for the credential.

        Output:
            httpx.Response: The raw HTTP response from the create-credential call.
        """
        return self._http.post(
            self.credentials_url(project_id),
            headers=self._json_headers(),
            json=self.credential_body(
                name=name,
                provider=provider,
                secret_data=secret_data,
                metadata=metadata,
            ),
        )

    def create_credential(
        self,
        project_id: str,
        request: CredentialCreateRequest,
    ) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/credentials`` — create a credential.

        Function use:
            Creates a credential under the given project from a typed request
            (expects ``201``); used by the MCP tools suites to provision the
            runtime credential a managed catalog MCP server references. The
            response never echoes ``secretData``.

        Input:
            project_id (str): The config-service project identifier.
            request (CredentialCreateRequest): The credential creation request,
                whose ``to_body()`` produces the request payload.

        Output:
            httpx.Response: The raw HTTP response from the create-credential call.
        """
        return self._http.post(
            self.credentials_url(project_id),
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def get_credential(self, project_id: str, credential_id: str) -> httpx.Response:
        """``GET /api/v1/projects/{projectId}/credentials/{id}`` — fetch a credential.

        Function use:
            Retrieves a single credential for validation checks (id, provider,
            metadata, timestamps); ``secretData`` is never returned.

        Input:
            project_id (str): The config-service project identifier.
            credential_id (str): The identifier of the credential to fetch.

        Output:
            httpx.Response: The raw HTTP response from the get-credential call.
        """
        return self._http.get(
            f"{self.credentials_url(project_id)}/{credential_id}",
            headers=self._json_headers(),
        )

    def delete_credential(self, project_id: str, credential_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}/credentials/{id}`` — delete a credential.

        Function use:
            Deletes a credential from the given project (expects ``204``); used
            during test cleanup after the MCP server that references it has been
            removed.

        Input:
            project_id (str): The config-service project identifier.
            credential_id (str): The identifier of the credential to delete.

        Output:
            httpx.Response: The raw HTTP response from the delete-credential call.
        """
        return self._http.delete(
            f"{self.credentials_url(project_id)}/{credential_id}",
            headers=self._json_headers(),
        )

    def mcp_servers_url(self, project_id: str) -> str:
        """Build the absolute MCP-servers collection URL for a project.

        Function use:
            Composes the full URL of the MCP-servers endpoint for the given
            project.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            str: The absolute URL of the project's MCP-servers collection.
        """
        return f"{self._base}/{self.project_prefix(project_id)}/mcp-servers"

    def add_mcp_server(
        self,
        project_id: str,
        request: ManagedMcpServerRequest,
    ) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/mcp-servers`` — create a managed server.

        Function use:
            Creates a managed (catalog) MCP server under the given project from
            a typed request (expects ``201``); the server begins provisioning
            asynchronously (``runtimeStatus: "provisioning"``).

        Input:
            project_id (str): The config-service project identifier.
            request (ManagedMcpServerRequest): The managed MCP-server creation
                request, whose ``to_body()`` produces the request payload.

        Output:
            httpx.Response: The raw HTTP response from the create-MCP-server call.
        """
        return self._http.post(
            self.mcp_servers_url(project_id),
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def add_custom_mcp(
        self,
        project_id: str,
        request: RemoteMcpServerRequest,
    ) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/mcp-servers`` — create a remote server.

        Function use:
            Creates a remote (self-hosted / externally supplied URL) MCP server
            under the given project from a typed request (expects ``201``); when
            the Bifrost gateway is enabled, config-service live-connects at
            create time and requires at least one tool.

        Input:
            project_id (str): The config-service project identifier.
            request (RemoteMcpServerRequest): The remote MCP-server creation
                request, whose ``to_body()`` produces the request payload.

        Output:
            httpx.Response: The raw HTTP response from the create-MCP-server call.
        """
        return self._http.post(
            self.mcp_servers_url(project_id),
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def get_mcp_server(self, project_id: str, mcp_id: str) -> httpx.Response:
        """``GET /api/v1/projects/{projectId}/mcp-servers/{id}`` — fetch one server.

        Function use:
            Retrieves a single MCP server row (project-scoped or shared
            platform server) for health/detail assertions (expects ``200``).

        Input:
            project_id (str): The config-service project identifier.
            mcp_id (str): The identifier of the MCP server to fetch.

        Output:
            httpx.Response: The raw HTTP response from the get-MCP-server call.
        """
        return self._http.get(
            f"{self.mcp_servers_url(project_id)}/{mcp_id}",
            headers=self._json_headers(),
        )

    def list_mcp_servers(self, project_id: str) -> httpx.Response:
        """``GET /api/v1/projects/{projectId}/mcp-servers`` — list project + platform servers.

        Function use:
            Lists the MCP servers visible to a project (its own servers plus the
            shared ``__platform__`` servers) as a JSON array (expects ``200``);
            used to discover the prebuilt platform MCP servers.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            httpx.Response: The raw HTTP response from the list-MCP-servers call.
        """
        return self._http.get(
            self.mcp_servers_url(project_id),
            headers=self._json_headers(),
        )

    def get_mcp_runtime_status(self, project_id: str, mcp_id: str) -> httpx.Response:
        """``GET .../mcp-servers/{id}/runtime-status`` — managed server runtime status.

        Function use:
            Reads the live runtime status of a managed MCP server
            (``runtimeStatus`` / ``ready`` / ``phase``); polled during
            provisioning until the pod is running and ready.

        Input:
            project_id (str): The config-service project identifier.
            mcp_id (str): The identifier of the managed MCP server.

        Output:
            httpx.Response: The raw HTTP response from the runtime-status call.
        """
        return self._http.get(
            f"{self.mcp_servers_url(project_id)}/{mcp_id}/runtime-status",
            headers=self._json_headers(),
        )

    def agents_url(self, project_id: str) -> str:
        """Build the absolute agents collection URL for a project.

        Function use:
            Composes the full URL of the agents endpoint for the given
            project.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            str: The absolute URL of the project's agents collection.
        """
        return f"{self._base}/{self.project_prefix(project_id)}/agents"

    def agent_teams_url(self, project_id: str) -> str:
        """Build the absolute agent-teams collection URL for a project.

        Function use:
            Composes the full URL of the agent-teams endpoint for the given
            project.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            str: The absolute URL of the project's agent-teams collection.
        """
        return f"{self._base}/{self.project_prefix(project_id)}/agent-teams"

    def create_agent(
        self,
        project_id: str,
        request: AgentCreationRequest,
    ) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/agents`` — create an agent.

        Function use:
            Creates an agent under the given project from a creation request
            (expects ``201``).

        Input:
            project_id (str): The config-service project identifier.
            request (AgentCreationRequest): The agent creation request, whose
                ``to_body()`` produces the request payload.

        Output:
            httpx.Response: The raw HTTP response from the create-agent call.
        """
        return self._http.post(
            self.agents_url(project_id),
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def create_team(
        self,
        project_id: str,
        request: TeamCreationRequest,
    ) -> httpx.Response:
        """``POST /api/v1/projects/{projectId}/agent-teams`` — create a team.

        Function use:
            Creates an agent team under the given project from a creation
            request (expects ``201``).

        Input:
            project_id (str): The config-service project identifier.
            request (TeamCreationRequest): The team creation request, whose
                ``to_body()`` produces the request payload.

        Output:
            httpx.Response: The raw HTTP response from the create-team call.
        """
        return self._http.post(
            self.agent_teams_url(project_id),
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def update_agent(
        self,
        project_id: str,
        agent_id: str,
        request: AgentCreationRequest,
    ) -> httpx.Response:
        """``PUT /api/v1/projects/{projectId}/agents/{id}`` — update an agent.

        Function use:
            Replaces editable fields of an existing agent with a full agent
            body (expects ``200``). Identity fields are stripped server-side;
            the complete creation-shaped body is sent so the update is a full
            overwrite of the editable surface rather than a partial patch.

        Input:
            project_id (str): The config-service project identifier.
            agent_id (str): The identifier of the agent to update.
            request (AgentCreationRequest): The request whose ``to_body()``
                produces the full update payload.

        Output:
            httpx.Response: The raw HTTP response from the update-agent call.
        """
        return self._http.put(
            f"{self._base}/{self.project_prefix(project_id)}/agents/{agent_id}",
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def update_team(
        self,
        project_id: str,
        team_id: str,
        request: TeamCreationRequest,
    ) -> httpx.Response:
        """``PUT /api/v1/projects/{projectId}/agent-teams/{id}`` — update a team.

        Function use:
            Replaces editable fields of an existing agent team with a full
            team body (expects ``200``). The complete creation-shaped body is
            sent (name, orchestration policy, members) so the update is a full
            overwrite of the editable surface rather than a partial patch.

        Input:
            project_id (str): The config-service project identifier.
            team_id (str): The identifier of the agent team to update.
            request (TeamCreationRequest): The request whose ``to_body()``
                produces the full update payload.

        Output:
            httpx.Response: The raw HTTP response from the update-team call.
        """
        return self._http.put(
            f"{self._base}/{self.project_prefix(project_id)}/agent-teams/{team_id}",
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def get_agent(self, project_id: str, agent_id: str) -> httpx.Response:
        """``GET /api/v1/projects/{projectId}/agents/{id}`` — fetch one agent.

        Function use:
            Retrieves a single agent configuration for validation checks such as
            KB bindings and RAG config shape (expects ``200``).

        Input:
            project_id (str): The config-service project identifier.
            agent_id (str): The identifier of the agent to fetch.

        Output:
            httpx.Response: The raw HTTP response from the get-agent call.
        """
        return self._http.get(
            f"{self._base}/{self.project_prefix(project_id)}/agents/{agent_id}",
            headers=self._json_headers(),
        )

    def get_team(self, project_id: str, team_id: str) -> httpx.Response:
        """``GET /api/v1/projects/{projectId}/agent-teams/{id}`` — fetch one team.

        Function use:
            Retrieves a single team configuration for validation checks such as
            orchestration and team-level memory settings (expects ``200``).

        Input:
            project_id (str): The config-service project identifier.
            team_id (str): The identifier of the team to fetch.

        Output:
            httpx.Response: The raw HTTP response from the get-team call.
        """
        return self._http.get(
            f"{self._base}/{self.project_prefix(project_id)}/agent-teams/{team_id}",
            headers=self._json_headers(),
        )

    def delete_agent(self, project_id: str, agent_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}/agents/{id}`` — delete an agent.

        Function use:
            Deletes an agent from the given project; used during test cleanup.

        Input:
            project_id (str): The config-service project identifier.
            agent_id (str): The identifier of the agent to delete.

        Output:
            httpx.Response: The raw HTTP response from the delete-agent call.
        """
        return self._http.delete(
            f"{self._base}/{self.project_prefix(project_id)}/agents/{agent_id}",
            headers=self._json_headers(),
        )

    def delete_team(self, project_id: str, team_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}/agent-teams/{id}`` — delete a team.

        Function use:
            Deletes an agent team from the given project; used during test
            cleanup.

        Input:
            project_id (str): The config-service project identifier.
            team_id (str): The identifier of the team to delete.

        Output:
            httpx.Response: The raw HTTP response from the delete-team call.
        """
        return self._http.delete(
            f"{self._base}/{self.project_prefix(project_id)}/agent-teams/{team_id}",
            headers=self._json_headers(),
        )

    def delete_model(self, project_id: str, model_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}/models/{id}`` — delete a model.

        Function use:
            Deletes a model from the given project; used during test cleanup.

        Input:
            project_id (str): The config-service project identifier.
            model_id (str): The identifier of the model to delete.

        Output:
            httpx.Response: The raw HTTP response from the delete-model call.
        """
        return self._http.delete(
            f"{self._base}/{self.project_prefix(project_id)}/models/{model_id}",
            headers=self._json_headers(),
        )

    def delete_kb(self, project_id: str, kb_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}/knowledgebases/{id}`` — delete a KB.

        Function use:
            Deletes a knowledge base from the given project; used during test
            cleanup.

        Input:
            project_id (str): The config-service project identifier.
            kb_id (str): The identifier of the knowledge base to delete.

        Output:
            httpx.Response: The raw HTTP response from the delete-KB call.
        """
        return self._http.delete(
            f"{self._base}/{self.project_prefix(project_id)}/knowledgebases/{kb_id}",
            headers=self._json_headers(),
        )

    def delete_mcp_server(self, project_id: str, mcp_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}/mcp-servers/{id}`` — delete a server.

        Function use:
            Deletes an MCP server from the given project; used during test
            cleanup.

        Input:
            project_id (str): The config-service project identifier.
            mcp_id (str): The identifier of the MCP server to delete.

        Output:
            httpx.Response: The raw HTTP response from the delete-MCP-server call.
        """
        return self._http.delete(
            f"{self._base}/{self.project_prefix(project_id)}/mcp-servers/{mcp_id}",
            headers=self._json_headers(),
        )

    def delete_project(self, project_id: str) -> httpx.Response:
        """``DELETE /api/v1/projects/{projectId}`` — delete a project.

        Function use:
            Deletes a project; used during test cleanup.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            httpx.Response: The raw HTTP response from the delete-project call.
        """
        return self._http.delete(
            f"{self._base}/api/v1/projects/{project_id}",
            headers=self._json_headers(),
        )

    # ── Evaluation templates + test cases ─────────────────────────────

    def evaluation_agents_url(self, project_id: str) -> str:
        """Build the absolute evaluation-agents base URL for a project."""
        return f"{self._base}/{self.project_prefix(project_id)}/evaluation/agents"

    def evaluation_templates_url(self, project_id: str) -> str:
        """Build the absolute evaluation-templates collection URL."""
        return f"{self.evaluation_agents_url(project_id)}/templates"

    def evaluation_testcases_url(self, project_id: str, eval_id: str) -> str:
        """Build the absolute eval-owned testcases URL for an ``evalId`` slug."""
        return f"{self.evaluation_agents_url(project_id)}/evaluations/{eval_id}/testcases"

    @staticmethod
    def slugify_eval_name(name: str) -> str:
        """Slugify ``evalName`` — must match config-service ``slugifyEvalName``."""
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower())
        slug = slug.strip("-")
        return slug or "unnamed"

    def create_evaluation_template(
        self,
        project_id: str,
        request: EvaluationTemplateCreateRequest,
    ) -> httpx.Response:
        """``POST .../evaluation/agents/templates`` — create a template (201)."""
        return self._http.post(
            self.evaluation_templates_url(project_id),
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def list_evaluation_templates(
        self,
        project_id: str,
        *,
        run_mode: str | None = None,
        suite: str | None = None,
        status: str | None = None,
    ) -> httpx.Response:
        """``GET .../evaluation/agents/templates`` — list templates (enriched)."""
        params: list[str] = []
        if run_mode is not None:
            params.append(f"runMode={run_mode}")
        if suite is not None:
            params.append(f"suite={suite}")
        if status is not None:
            params.append(f"status={status}")
        url = self.evaluation_templates_url(project_id)
        if params:
            url = f"{url}?{'&'.join(params)}"
        return self._http.get(url, headers=self._json_headers())

    def get_evaluation_template_details(
        self,
        project_id: str,
        template_id: str,
    ) -> httpx.Response:
        """``GET .../evaluation/agents/templates/{templateId}`` — fetch full details."""
        return self._http.get(
            f"{self.evaluation_templates_url(project_id)}/{template_id}",
            headers=self._json_headers(),
        )

    def update_evaluation_template(
        self,
        project_id: str,
        template_id: str,
        request: EvaluationTemplateUpdateRequest,
    ) -> httpx.Response:
        """``PATCH .../evaluation/agents/templates/{templateId}`` — partial update."""
        return self._http.patch(
            f"{self.evaluation_templates_url(project_id)}/{template_id}",
            headers=self._json_headers(),
            json=request.to_body(),
        )

    def delete_evaluation_template(
        self,
        project_id: str,
        template_id: str,
        *,
        hard: bool = False,
    ) -> httpx.Response:
        """``DELETE .../evaluation/agents/templates/{templateId}`` — delete (204)."""
        url = f"{self.evaluation_templates_url(project_id)}/{template_id}"
        if hard:
            url = f"{url}?hard=true"
        return self._http.delete(url, headers=self._json_headers())

    def upload_evaluation_testcases(
        self,
        project_id: str,
        eval_id: str,
        data: bytes,
        *,
        filename: str = "cases.jsonl",
    ) -> httpx.Response:
        """``PUT .../evaluations/{evalId}/testcases`` — upload raw JSON/JSONL bytes."""
        url = f"{self.evaluation_testcases_url(project_id, eval_id)}?filename={filename}"
        return self._http.put(
            url,
            headers=self._raw_headers("application/x-ndjson"),
            content=data,
        )

    def get_evaluation_testcases(
        self,
        project_id: str,
        eval_id: str,
        *,
        include: str = "metadata",
    ) -> httpx.Response:
        """``GET .../evaluations/{evalId}/testcases`` — metadata or body."""
        url = f"{self.evaluation_testcases_url(project_id, eval_id)}?include={include}"
        return self._http.get(url, headers=self._json_headers())

    # ── Evaluation runs ─────────────────────────────────────────────

    def evaluation_runs_url(self, project_id: str) -> str:
        """Build the absolute evaluation-runs collection URL."""
        return f"{self.evaluation_agents_url(project_id)}/runs"

    def trigger_evaluation_run(
        self,
        project_id: str,
        template_id: str,
        *,
        run_id: str | None = None,
        name: str | None = None,
        actor: str | None = None,
        reason: str | None = None,
    ) -> httpx.Response:
        """``POST .../templates/{templateId}/runs`` — trigger a run (202)."""
        body: dict[str, Any] = {}
        if run_id is not None:
            body["runId"] = run_id
        if name is not None:
            body["name"] = name
        if actor is not None:
            body["actor"] = actor
        if reason is not None:
            body["reason"] = reason
        url = f"{self.evaluation_templates_url(project_id)}/{template_id}/runs"
        return self._http.post(url, headers=self._json_headers(), json=body)

    def get_evaluation_run(
        self,
        project_id: str,
        run_id: str,
    ) -> httpx.Response:
        """``GET .../runs/{runId}`` — fetch a single run."""
        return self._http.get(
            f"{self.evaluation_runs_url(project_id)}/{run_id}",
            headers=self._json_headers(),
        )

    def list_evaluation_runs(
        self,
        project_id: str,
        *,
        template_id: str | None = None,
        status: str | None = None,
        limit: int | None = None,
        skip: int | None = None,
    ) -> httpx.Response:
        """``GET .../runs`` — list runs with optional filters."""
        params: list[str] = []
        if template_id is not None:
            params.append(f"templateId={template_id}")
        if status is not None:
            params.append(f"status={status}")
        if limit is not None:
            params.append(f"limit={limit}")
        if skip is not None:
            params.append(f"skip={skip}")
        url = self.evaluation_runs_url(project_id)
        if params:
            url = f"{url}?{'&'.join(params)}"
        return self._http.get(url, headers=self._json_headers())

    def get_evaluation_run_audit_events(
        self,
        project_id: str,
        run_id: str,
    ) -> httpx.Response:
        """``GET .../runs/{runId}/audit-events`` — fetch the run audit trail."""
        return self._http.get(
            f"{self.evaluation_runs_url(project_id)}/{run_id}/audit-events",
            headers=self._json_headers(),
        )
