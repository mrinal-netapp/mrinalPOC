"""Typed ledger of config-service resources created by a test suite.

A ``SuiteResources`` instance is owned by each agent-service suite and is
appended to only when the suite actually creates a resource. Env-reused
resources (e.g. a project/model supplied via environment) are never added, so
the shared cleanup flow deletes only what the suite itself provisioned.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ResourceRef:
    """A reference to a project-scoped config-service resource."""

    id: str
    project_id: str


@dataclass
class SuiteResources:
    """Mutable ledger of resources a single suite created, in creation order."""

    projects: list[str] = field(default_factory=list)
    models: list[ResourceRef] = field(default_factory=list)
    agents: list[ResourceRef] = field(default_factory=list)
    teams: list[ResourceRef] = field(default_factory=list)
    credentials: list[ResourceRef] = field(default_factory=list)
    mcp_servers: list[ResourceRef] = field(default_factory=list)
    evaluation_templates: list[ResourceRef] = field(default_factory=list)

    def add_project(self, project_id: str) -> None:
        """Record a project the suite created.

        Function use:
            Tracks a freshly created project so it can be deleted during
            teardown; no-op for empty or already-tracked ids.

        Input:
            project_id (str): The config-service project identifier.

        Output:
            None
        """
        if project_id and project_id not in self.projects:
            self.projects.append(project_id)

    def add_model(self, model_id: str, project_id: str) -> None:
        """Record a model the suite created.

        Function use:
            Tracks a freshly created model (with its owning project) for
            teardown; no-op for empty or already-tracked refs.

        Input:
            model_id (str): The config-service model identifier.
            project_id (str): The project the model belongs to.

        Output:
            None
        """
        self._add(self.models, model_id, project_id)

    def add_agent(self, agent_id: str, project_id: str) -> None:
        """Record an agent the suite created.

        Function use:
            Tracks a freshly created agent (with its owning project) for
            teardown; no-op for empty or already-tracked refs.

        Input:
            agent_id (str): The config-service agent identifier.
            project_id (str): The project the agent belongs to.

        Output:
            None
        """
        self._add(self.agents, agent_id, project_id)

    def add_team(self, team_id: str, project_id: str) -> None:
        """Record a team the suite created.

        Function use:
            Tracks a freshly created agent team (with its owning project) for
            teardown; no-op for empty or already-tracked refs.

        Input:
            team_id (str): The config-service agent-team identifier.
            project_id (str): The project the team belongs to.

        Output:
            None
        """
        self._add(self.teams, team_id, project_id)

    def add_credential(self, credential_id: str, project_id: str) -> None:
        """Record a credential the suite created.

        Function use:
            Tracks a freshly created credential (with its owning project) for
            teardown; no-op for empty or already-tracked refs.

        Input:
            credential_id (str): The config-service credential identifier.
            project_id (str): The project the credential belongs to.

        Output:
            None
        """
        self._add(self.credentials, credential_id, project_id)

    def add_mcp_server(self, mcp_id: str, project_id: str) -> None:
        """Record an MCP server the suite created.

        Function use:
            Tracks a freshly created MCP server (with its owning project) for
            teardown; no-op for empty or already-tracked refs.

        Input:
            mcp_id (str): The config-service MCP server identifier.
            project_id (str): The project the MCP server belongs to.

        Output:
            None
        """
        self._add(self.mcp_servers, mcp_id, project_id)

    def add_evaluation_template(self, template_id: str, project_id: str) -> None:
        """Record an evaluation template the suite created."""
        self._add(self.evaluation_templates, template_id, project_id)

    def is_empty(self) -> bool:
        """Report whether the ledger has tracked any resource.

        Function use:
            Lets callers short-circuit cleanup when nothing was created.

        Input:
            None

        Output:
            bool: ``True`` when no projects, models, agents, teams,
            credentials, or MCP servers are tracked; ``False`` otherwise.
        """
        return not (
            self.projects
            or self.models
            or self.agents
            or self.teams
            or self.credentials
            or self.mcp_servers
            or self.evaluation_templates
        )

    @staticmethod
    def _add(bucket: list[ResourceRef], resource_id: str, project_id: str) -> None:
        if not resource_id or not project_id:
            return
        ref = ResourceRef(id=resource_id, project_id=project_id)
        if ref not in bucket:
            bucket.append(ref)
