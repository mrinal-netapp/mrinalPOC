"""HTTP client for agent-service sync invoke + liveness/readiness probes.

Provisioning uses ``lib.config_service.client.ConfigServiceClient``; this
client covers agent-service invoke endpoints and ``/health`` / ``/ready`` probes.
``AGENT_SERVICE_URL`` must resolve to the API-version root — invoke paths are
built as ``{base}/projects/...`` (no ``/api/v1``). Against the deployed edge use
the ``/agents-maf`` route, whose gateway rewrite maps the prefix to ``/api/v1``;
for direct access include ``/api/v1`` in the URL (e.g. ``http://host:8000/api/v1``).
Authentication is opt-in via ``ENABLE_AUTH_AGENT_SERVICE`` (Keycloak
``password`` grant user token — the deployed edge authorizes on project-scoped
permissions); when unset, calls are unauthenticated.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from lib.authentication.keycloak_client import auth_enabled
from lib.common.auth import KeycloakAuth
from lib.common.settings import IntegrationSettings
from lib.models.agent_invoke_request import AgentInvocationRequest

from .env import AgentServiceConfig
from .streaming import StreamResult, parse_sse_lines
from .websocket import WSResult, collect_ws


def _invoke_body(body: AgentInvocationRequest | dict[str, Any]) -> dict[str, Any]:
    """Normalize an invoke body to a JSON dict.

    Accepts the typed :class:`AgentInvocationRequest` (preferred) or a raw
    ``dict`` (back-compat for suites not yet migrated).
    """
    if isinstance(body, AgentInvocationRequest):
        return body.to_body()
    return body


class AgentServiceClient:
    def __init__(
        self,
        config: AgentServiceConfig,
        settings: IntegrationSettings,
    ) -> None:
        self._config = config
        self._base = config.agent_service_url
        # ws:// for http://, wss:// for https:// — used by the WS invoke methods.
        if self._base.startswith("https://"):
            self._ws_base = "wss://" + self._base[len("https://") :]
        elif self._base.startswith("http://"):
            self._ws_base = "ws://" + self._base[len("http://") :]
        else:
            self._ws_base = self._base
        timeout = httpx.Timeout(120.0, connect=60.0)
        self._verify_tls = settings.verify_tls
        self._http = httpx.Client(
            verify=settings.verify_tls, timeout=timeout, trust_env=False
        )
        self._use_auth = auth_enabled("ENABLE_AUTH_AGENT_SERVICE")
        # User-token (Keycloak password grant) auth: the deployed edge (Istio
        # UMA-RPT) authorizes on project-scoped permissions, so we authenticate
        # as the realm user that owns the project rather than a service account.
        self._keycloak = KeycloakAuth(settings) if self._use_auth else None

    def close(self) -> None:
        """Close the underlying HTTP client and any Keycloak client.

        Function use:
            Releases the httpx client and, when auth is enabled, the
            Keycloak client; called during suite teardown.

        Input:
            None

        Output:
            None
        """
        self._http.close()

    def _json_headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        if self._use_auth and self._keycloak is not None:
            token = self._keycloak.get_access_token(self._http)
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _sse_headers(self) -> dict[str, str]:
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        if self._use_auth and self._keycloak is not None:
            token = self._keycloak.get_access_token(self._http)
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _ws_headers(self) -> dict[str, str]:
        """Handshake headers for WS invokes.

        When ``ENABLE_AUTH_AGENT_SERVICE`` is enabled, attach the same Keycloak
        bearer token used by the HTTP/SSE paths; otherwise no auth header.
        """
        if self._use_auth and self._keycloak is not None:
            token = self._keycloak.get_access_token(self._http)
            return {"Authorization": f"Bearer {token}"}
        return {}

    def probe(self, base_url: str, path: str) -> httpx.Response:
        """GET against ``{base_url}/{path}`` for liveness/readiness probes.

        Function use:
            Issues an unauthenticated GET to a health/readiness endpoint
            such as ``/health`` or ``/ready``.

        Input:
            base_url (str): Service base URL.
            path (str): Probe path appended to the base URL.

        Output:
            httpx.Response: The probe HTTP response.
        """
        url = f"{base_url.rstrip('/')}/{path.lstrip('/')}"
        return self._http.get(url, headers={"Accept": "application/json"})

    def invoke_agent(
        self,
        project_id: str,
        agent_id: str,
        body: AgentInvocationRequest | dict[str, Any],
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        """``POST .../agents/{agentId}/invoke`` — synchronous agent invoke.

        Function use:
            Posts the invoke body to the agent's sync invoke endpoint and
            returns the raw response.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.
            params (dict[str, str] | None): Optional query parameters to
                append to the request URL (e.g. ``{"staging": "playground"}``).

        Output:
            httpx.Response: The invoke HTTP response.
        """
        url = (
            f"{self._base}/projects/{project_id}"
            f"/agents/{agent_id}/invoke"
        )
        return self._http.post(
            url, headers=self._json_headers(), json=_invoke_body(body), params=params
        )

    def invoke_team(
        self,
        project_id: str,
        team_id: str,
        body: AgentInvocationRequest | dict[str, Any],
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        """``POST .../agent-teams/{teamId}/invoke`` — synchronous team invoke.

        Function use:
            Posts the invoke body to the team's sync invoke endpoint and
            returns the raw response.

        Input:
            project_id (str): Project identifier.
            team_id (str): Agent team identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.
            params (dict[str, str] | None): Optional query parameters to
                append to the request URL (e.g. ``{"staging": "playground"}``).

        Output:
            httpx.Response: The invoke HTTP response.
        """
        url = (
            f"{self._base}/projects/{project_id}"
            f"/agent-teams/{team_id}/invoke"
        )
        return self._http.post(
            url, headers=self._json_headers(), json=_invoke_body(body), params=params
        )

    def _stream(
        self,
        url: str,
        body: AgentInvocationRequest | dict[str, Any],
        params: dict[str, str] | None = None,
    ) -> StreamResult:
        """POST to an SSE ``/invoke/stream`` endpoint and collect every event.

        Consumes the full ``text/event-stream`` response and returns a
        :class:`StreamResult`. On a non-200 response (a JSON error, not SSE) the
        body is captured in ``raw_non_sse_body`` and ``events`` is empty.
        """
        with self._http.stream(
            "POST",
            url,
            headers=self._sse_headers(),
            json=_invoke_body(body),
            params=params,
        ) as resp:
            if resp.status_code != 200:
                resp.read()
                return StreamResult(
                    status_code=resp.status_code,
                    headers=dict(resp.headers),
                    events=[],
                    raw_non_sse_body=resp.text,
                )
            events = parse_sse_lines(resp.iter_lines())
            return StreamResult(
                status_code=resp.status_code,
                headers=dict(resp.headers),
                events=events,
            )

    def invoke_agent_stream(
        self,
        project_id: str,
        agent_id: str,
        body: AgentInvocationRequest | dict[str, Any],
        params: dict[str, str] | None = None,
    ) -> StreamResult:
        """``POST .../agents/{agentId}/invoke/stream`` — SSE agent invoke.

        Function use:
            Posts the invoke body to the agent's SSE streaming endpoint and
            collects every event into a StreamResult.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.
            params (dict[str, str] | None): Optional query parameters to
                append to the request URL (e.g. ``{"staging": "playground"}``).

        Output:
            StreamResult: The eagerly-collected streaming result.
        """
        url = (
            f"{self._base}/projects/{project_id}"
            f"/agents/{agent_id}/invoke/stream"
        )
        return self._stream(url, body, params=params)

    def invoke_team_stream(
        self,
        project_id: str,
        team_id: str,
        body: AgentInvocationRequest | dict[str, Any],
        params: dict[str, str] | None = None,
    ) -> StreamResult:
        """``POST .../agent-teams/{teamId}/invoke/stream`` — SSE team invoke.

        Function use:
            Posts the invoke body to the team's SSE streaming endpoint and
            collects every event into a StreamResult.

        Input:
            project_id (str): Project identifier.
            team_id (str): Agent team identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.
            params (dict[str, str] | None): Optional query parameters to
                append to the request URL (e.g. ``{"staging": "playground"}``).

        Output:
            StreamResult: The eagerly-collected streaming result.
        """
        url = (
            f"{self._base}/projects/{project_id}"
            f"/agent-teams/{team_id}/invoke/stream"
        )
        return self._stream(url, body, params=params)

    def invoke_agent_ws(
        self,
        project_id: str,
        agent_id: str,
        body: AgentInvocationRequest | dict[str, Any],
    ) -> WSResult:
        """``WS .../agents/{agentId}/ws`` — bidirectional WebSocket agent invoke.

        Function use:
            Opens the socket, sends one ``InvokeRequest`` frame, and eagerly
            collects the streamed event frames. Synchronous wrapper around the
            async ``websockets`` client so the suites stay synchronous.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.

        Output:
            WSResult: The eagerly-collected WebSocket result.
        """
        url = (
            f"{self._ws_base}/projects/{project_id}"
            f"/agents/{agent_id}/ws"
        )
        return asyncio.run(
            collect_ws(
                url,
                _invoke_body(body),
                headers=self._ws_headers(),
                verify_tls=self._verify_tls,
            )
        )

    def invoke_team_ws(
        self,
        project_id: str,
        team_id: str,
        body: AgentInvocationRequest | dict[str, Any],
    ) -> WSResult:
        """``WS .../agent-teams/{teamId}/ws`` — bidirectional WebSocket team invoke.

        Function use:
            Opens the socket, sends one ``InvokeRequest`` frame, and eagerly
            collects the streamed event frames. Synchronous wrapper around the
            async ``websockets`` client so the suites stay synchronous.

        Input:
            project_id (str): Project identifier.
            team_id (str): Agent team identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.

        Output:
            WSResult: The eagerly-collected WebSocket result.
        """
        url = (
            f"{self._ws_base}/projects/{project_id}"
            f"/agent-teams/{team_id}/ws"
        )
        return asyncio.run(
            collect_ws(
                url,
                _invoke_body(body),
                headers=self._ws_headers(),
                verify_tls=self._verify_tls,
            )
        )

    def invoke_agent_async(
        self,
        project_id: str,
        agent_id: str,
        body: AgentInvocationRequest | dict[str, Any],
    ) -> httpx.Response:
        """``POST .../agents/{agentId}/invoke/async`` — fire-and-forget agent invoke.

        Submits the agent invocation as a background task and returns
        immediately with HTTP 202. The response body contains ``taskId``
        and ``status`` (always ``"running"`` at submission time). Poll
        :meth:`get_task_details` until ``status`` reaches a terminal value.

        Function use:
            Posts the invoke body to the agent's async endpoint and returns
            the raw HTTP 202 response containing ``taskId``.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.

        Output:
            httpx.Response: HTTP 202 response with ``{ taskId, status }``.
        """
        url = (
            f"{self._base}/projects/{project_id}"
            f"/agents/{agent_id}/invoke/async"
        )
        return self._http.post(url, headers=self._json_headers(), json=_invoke_body(body))

    def invoke_team_async(
        self,
        project_id: str,
        team_id: str,
        body: AgentInvocationRequest | dict[str, Any],
    ) -> httpx.Response:
        """``POST .../agent-teams/{teamId}/invoke/async`` — fire-and-forget team invoke.

        Submits the team orchestration pipeline as a background task and
        returns immediately with HTTP 202. The response body contains
        ``taskId`` and ``status`` (always ``"running"`` at submission time).
        Poll :meth:`get_task_details` until ``status`` reaches a terminal value.

        Function use:
            Posts the invoke body to the team's async endpoint and returns
            the raw HTTP 202 response containing ``taskId``.

        Input:
            project_id (str): Project identifier.
            team_id (str): Agent team identifier.
            body (AgentInvocationRequest | dict[str, Any]): Invoke payload.

        Output:
            httpx.Response: HTTP 202 response with ``{ taskId, status }``.
        """
        url = (
            f"{self._base}/projects/{project_id}"
            f"/agent-teams/{team_id}/invoke/async"
        )
        return self._http.post(url, headers=self._json_headers(), json=_invoke_body(body))

    def get_task_details(
        self,
        project_id: str,
        task_id: str,
    ) -> httpx.Response:
        """``GET .../tasks/{taskId}`` — poll an async task by id.

        Returns the current ``TaskStatusResponse`` for the given task.
        ``result`` (an ``InvokeResponse``-shaped object) is populated once
        ``status == "completed"``; ``error`` and ``errorType`` are populated
        when ``status`` is ``"failed"`` or ``"cancelled"``.

        Function use:
            Fetches the task status from the project-scoped tasks endpoint.
            Call repeatedly until ``status`` is terminal (``completed`` /
            ``failed`` / ``cancelled``).

        Input:
            project_id (str): Project identifier.
            task_id (str): UUID4 task identifier returned by an async invoke.

        Output:
            httpx.Response: HTTP 200 response with the full
                ``TaskStatusResponse`` body.
        """
        return self._http.get(
            f"{self._base}/projects/{project_id}/tasks/{task_id}",
            headers=self._json_headers(),
        )

    def cancel_task(
        self,
        project_id: str,
        task_id: str,
    ) -> httpx.Response:
        """``DELETE .../tasks/{taskId}`` -- cancel a running async task.

        Sends ``CancelledError`` to the live background coroutine so it stops
        promptly, then persists ``status = "cancelled"`` and
        ``error = "Cancelled by caller"`` on the task. Already-terminal tasks
        (``completed`` / ``failed`` / ``cancelled``) are returned unchanged
        -- the operation is idempotent.

        Function use:
            Issues a DELETE to the project-scoped task endpoint and returns
            the updated ``TaskStatusResponse`` (HTTP 200) so callers can
            immediately inspect the post-cancel state.

        Input:
            project_id (str): Project identifier.
            task_id (str): UUID4 task identifier returned by an async invoke.

        Output:
            httpx.Response: HTTP 200 response with the full
                ``TaskStatusResponse`` body (``status`` is ``"cancelled"``
                for a previously running task).
        """
        return self._http.delete(
            f"{self._base}/projects/{project_id}/tasks/{task_id}",
            headers=self._json_headers(),
        )

    def agent_sessions_url(self, project_id: str, agent_id: str) -> str:
        """Build the agent-scoped sessions collection URL.

        Function use:
            Constructs the ``.../agents/{agentId}/sessions`` URL used by the
            session list/get/rename/delete helpers.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.

        Output:
            str: The agent sessions collection URL.
        """
        return (
            f"{self._base}/projects/{project_id}"
            f"/agents/{agent_id}/sessions"
        )

    def list_agent_sessions(self, project_id: str, agent_id: str) -> httpx.Response:
        """``GET .../agents/{agentId}/sessions`` — list agent-scoped sessions.

        Function use:
            Fetches the list of sessions scoped to the agent.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.

        Output:
            httpx.Response: The list-sessions HTTP response.
        """
        return self._http.get(
            self.agent_sessions_url(project_id, agent_id),
            headers=self._json_headers(),
        )

    def get_agent_session(
        self, project_id: str, agent_id: str, session_id: str
    ) -> httpx.Response:
        """``GET .../agents/{agentId}/sessions/{sessionId}`` — get a transcript.

        Function use:
            Fetches a single session transcript by id.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            session_id (str): Session identifier.

        Output:
            httpx.Response: The get-session HTTP response.
        """
        return self._http.get(
            f"{self.agent_sessions_url(project_id, agent_id)}/{session_id}",
            headers=self._json_headers(),
        )

    def rename_agent_session(
        self, project_id: str, agent_id: str, session_id: str, name: str
    ) -> httpx.Response:
        """``PATCH .../agents/{agentId}/sessions/{sessionId}`` — rename a session.

        Function use:
            Renames a session via PATCH with the supplied name.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            session_id (str): Session identifier.
            name (str): New session name.

        Output:
            httpx.Response: The rename HTTP response.
        """
        return self._http.patch(
            f"{self.agent_sessions_url(project_id, agent_id)}/{session_id}",
            headers=self._json_headers(),
            json={"name": name},
        )

    def delete_agent_session(
        self, project_id: str, agent_id: str, session_id: str
    ) -> httpx.Response:
        """``DELETE .../agents/{agentId}/sessions/{sessionId}`` — delete a session.

        Function use:
            Deletes a session by id; the service responds with ``204``.

        Input:
            project_id (str): Project identifier.
            agent_id (str): Agent identifier.
            session_id (str): Session identifier.

        Output:
            httpx.Response: The delete HTTP response (``204`` on success).
        """
        return self._http.delete(
            f"{self.agent_sessions_url(project_id, agent_id)}/{session_id}",
            headers=self._json_headers(),
        )
