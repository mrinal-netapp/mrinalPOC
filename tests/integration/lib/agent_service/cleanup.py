"""Shared, best-effort teardown for agent-service suite resources.

Each suite tracks what it creates in a ``SuiteResources`` ledger and calls
``cleanup_resources`` from its after-class (or session) teardown. Deletion is
gated by ``INTEGRATION_CLEANUP`` and ordered evaluation_templates (hard) ->
teams -> agents -> models -> mcp_servers -> credentials -> projects (the MCP
references its runtime credential, so the credential is deleted only after the
MCP; the project delete acts as a cascade backstop). Failures are logged, never
raised.
"""

from __future__ import annotations

from typing import Callable

import httpx

from lib.common.logger import log
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.models.resources import SuiteResources

_CLEANUP_OK = (200, 202, 204, 404, 409)


def _safe_delete(label: str, fn: Callable[[], httpx.Response]) -> None:
    """Run a delete call, log its HTTP status, and never raise.

    Function use:
        Wraps a single resource delete so a teardown loop can continue even if
        one delete errors or returns an unexpected status.

    Input:
        label (str): Human-readable resource label for the log line.
        fn (Callable[[], httpx.Response]): Zero-arg callable performing the
            delete request.

    Output:
        None
    """
    try:
        resp = fn()
        lvl = "" if resp.status_code in _CLEANUP_OK else " UNEXPECTED"
        log.info(f"  [cleanup]{lvl} {label}: HTTP {resp.status_code}")
    except Exception as exc:
        log.info(f"  [cleanup] {label}: failed ({exc})")


def cleanup_resources(
    client: ConfigServiceClient,
    settings: IntegrationSettings,
    resources: SuiteResources,
) -> None:
    """Delete every resource a suite created, gated by ``INTEGRATION_CLEANUP``.

    Function use:
        Suite teardown helper that removes only suite-created resources, in
        dependency order, logging each outcome and swallowing errors.

    Input:
        client (ConfigServiceClient): Config-service client used for deletes.
        settings (IntegrationSettings): Provides the ``integration_cleanup``
            flag that gates teardown.
        resources (SuiteResources): Ledger of resources the suite created.

    Output:
        None
    """
    if not settings.integration_cleanup:
        log.info("  [cleanup] INTEGRATION_CLEANUP disabled — skipping teardown")
        return
    if resources.is_empty():
        return

    for team in resources.teams:
        _safe_delete(
            f"team {team.id}",
            lambda r=team: client.delete_team(r.project_id, r.id),
        )
    for agent in resources.agents:
        _safe_delete(
            f"agent {agent.id}",
            lambda r=agent: client.delete_agent(r.project_id, r.id),
        )
    for template in resources.evaluation_templates:
        _safe_delete(
            f"evaluation template {template.id}",
            lambda r=template: client.delete_evaluation_template(
                r.project_id, r.id, hard=True
            ),
        )
    for model in resources.models:
        _safe_delete(
            f"model {model.id}",
            lambda r=model: client.delete_model(r.project_id, r.id),
        )
    for mcp_server in resources.mcp_servers:
        _safe_delete(
            f"mcp server {mcp_server.id}",
            lambda r=mcp_server: client.delete_mcp_server(r.project_id, r.id),
        )
    for credential in resources.credentials:
        _safe_delete(
            f"credential {credential.id}",
            lambda r=credential: client.delete_credential(r.project_id, r.id),
        )
    for project_id in resources.projects:
        _safe_delete(
            f"project {project_id}",
            lambda p=project_id: client.delete_project(p),
        )
