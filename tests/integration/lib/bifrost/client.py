"""HTTP client for the Bifrost LLM gateway's raw MCP API.

Talks directly to Bifrost (``LLM_GATEWAY_URL``, e.g. ``http://localhost:8082``),
bypassing config-service, to exercise a registered remote MCP end-to-end:

    list clients/tools -> reconnect (test connection) -> call a tool

Client management uses the REST API (``/api/mcp/clients``,
``/api/mcp/client/{id}/reconnect``); tool invocation uses the aggregated
streamable-HTTP JSON-RPC endpoint (``POST /mcp``) with hyphen-prefixed tool
names (``{clientName}-{tool}``). Auth headers are sent only when
``LLM_GATEWAY_API_KEY`` is set (local Bifrost is unauthenticated).
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx

from lib.common.settings import IntegrationSettings, _strip


def pretty_tool_result(result: dict) -> str:
    """Render an MCP tool-call result as indented JSON for readable logs.

    Function use:
        Text content blocks that themselves hold a JSON document are parsed and
        re-serialized so the payload is pretty-printed rather than dumped as a
        single escaped line; anything non-JSON is left as-is.

    Input:
        result (dict): The JSON-RPC ``result`` object from a tool call.

    Output:
        str: An indented JSON rendering of the result.
    """
    blocks = result.get("content") or []
    for block in blocks:
        text = block.get("text") if isinstance(block, dict) else None
        if isinstance(text, str):
            try:
                block["text"] = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                pass
    return json.dumps(result, indent=2, ensure_ascii=False)


class BifrostClient:
    """Direct client for the Bifrost gateway MCP endpoints."""

    def __init__(
        self,
        base_url: str,
        *,
        verify_tls: bool = True,
        api_key: str = "",
    ) -> None:
        self._base = base_url.rstrip("/")
        self._api_key = api_key
        timeout = httpx.Timeout(120.0, connect=60.0)
        self._http = httpx.Client(verify=verify_tls, timeout=timeout, trust_env=False)

    @classmethod
    def from_env(cls, settings: IntegrationSettings) -> "BifrostClient | None":
        """Build a client from ``LLM_GATEWAY_URL``.

        Function use:
            Resolves the Bifrost gateway base URL from the environment and
            constructs a client; returns ``None`` when ``LLM_GATEWAY_URL`` is
            unset so the suite can skip the Bifrost-backed cases.

        Input:
            settings (IntegrationSettings): Integration settings (used for TLS
                verification).

        Output:
            BifrostClient | None: A configured client, or ``None`` when no
            gateway endpoint is set.
        """
        base = _strip(os.environ.get("LLM_GATEWAY_URL"))
        if not base:
            return None
        return cls(
            base,
            verify_tls=settings.verify_tls,
            api_key=_strip(os.environ.get("LLM_GATEWAY_API_KEY")),
        )

    def close(self) -> None:
        """Close the underlying HTTP client.

        Function use:
            Releases network resources held by this client; call in test
            teardown.

        Input:
            None

        Output:
            None
        """
        self._http.close()

    def _headers(self, *, json_body: bool = False) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if json_body:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
            headers["x-api-key"] = self._api_key
        return headers

    def list_clients(self) -> list[dict[str, Any]]:
        """``GET /api/mcp/clients`` — all MCP clients registered with Bifrost.

        Function use:
            Lists the MCP clients Bifrost currently knows about; used to locate
            a registered remote MCP and its reported tools.

        Input:
            None

        Output:
            list[dict[str, Any]]: The registered client entries (normalized to a
            list whether the payload is a bare array or ``{"clients": [...]}``).
        """
        resp = self._http.get(
            f"{self._base}/api/mcp/clients", headers=self._headers()
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict):
            return data.get("clients", []) or []
        return data or []

    def get_client(self, name: str) -> dict[str, Any] | None:
        """Find one registered client by its Bifrost name.

        Function use:
            Locates the client entry whose name matches the config-service
            ``llmproxyGatewayServerName`` (checked against both ``name`` and
            ``config.name``).

        Input:
            name (str): The Bifrost client name to find.

        Output:
            dict[str, Any] | None: The matching client entry, or ``None``.
        """
        for entry in self.list_clients():
            cfg = entry.get("config") or {}
            if entry.get("name") == name or cfg.get("name") == name:
                return entry
        return None

    def list_tools(self, name: str) -> list[dict[str, Any]]:
        """Top-level ``tools[]`` reported by Bifrost for the given client.

        Function use:
            Returns the tools Bifrost has discovered for a registered MCP
            client; used to assert the remote MCP exposes tools.

        Input:
            name (str): The Bifrost client name.

        Output:
            list[dict[str, Any]]: The client's tool descriptors (empty when the
            client is unknown).
        """
        entry = self.get_client(name)
        if entry is None:
            return []
        return entry.get("tools", []) or []

    def reconnect(self, client_id: str) -> httpx.Response:
        """``POST /api/mcp/client/{id}/reconnect`` — force a live reconnect.

        Function use:
            Triggers Bifrost to re-establish the connection to a registered MCP
            client (the raw-gateway equivalent of a connection test).

        Input:
            client_id (str): The Bifrost client identifier.

        Output:
            httpx.Response: The raw HTTP response from the reconnect call.
        """
        return self._http.post(
            f"{self._base}/api/mcp/client/{client_id}/reconnect",
            headers=self._headers(json_body=True),
        )

    def test_connection(
        self,
        name: str,
        *,
        reconnect_id: str = "",
    ) -> dict[str, Any]:
        """Reconnect + return ``{state, tool_count, reconnect_status}``.

        Function use:
            Forces a reconnect and reports the resulting connection state and
            tool count; mirrors config-service's connection-test behaviour
            directly against Bifrost. The reconnect is best-effort: a non-2xx
            response is tolerated (its status is returned) so callers can still
            assess health from the client's live tool list.

        Input:
            name (str): The Bifrost client name (used to read live state/tools).
            reconnect_id (str): The Bifrost client id to reconnect (the
                config-service ``llmproxyGatewayServerId``). Falls back to the
                entry's ``id`` / ``name`` when empty.

        Output:
            dict[str, Any]: ``{"state": <str>, "tool_count": <int>,
            "reconnect_status": <int>}``.
        """
        entry = self.get_client(name)
        if entry is None:
            return {"state": "not_found", "tool_count": 0, "reconnect_status": 0}
        client_id = reconnect_id or entry.get("id") or entry.get("name") or name
        resp = self.reconnect(str(client_id))
        entry = self.get_client(name) or entry
        return {
            "state": entry.get("state") or entry.get("status") or "unknown",
            "tool_count": len(entry.get("tools", []) or []),
            "reconnect_status": resp.status_code,
        }

    def call_tool(
        self,
        client_name: str,
        tool: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        """``POST /mcp`` JSON-RPC ``tools/call`` for ``{client_name}-{tool}``.

        Function use:
            Invokes an MCP tool through Bifrost's aggregated streamable-HTTP
            JSON-RPC endpoint using the hyphen-prefixed tool name, handling both
            plain-JSON and SSE (``data:``) responses.

        Input:
            client_name (str): The Bifrost client name (tool-name prefix).
            tool (str): The bare tool name (e.g. ``weather_forecast``).
            arguments (dict[str, Any]): The tool arguments object.

        Output:
            dict[str, Any]: The JSON-RPC ``result`` object (``content`` /
            ``isError``).
        """
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": f"{client_name}-{tool}", "arguments": arguments},
        }
        headers = self._headers(json_body=True)
        headers["Accept"] = "application/json, text/event-stream"
        resp = self._http.post(f"{self._base}/mcp", headers=headers, json=payload)
        resp.raise_for_status()
        envelope = self._parse_rpc(resp)
        if "error" in envelope:
            raise AssertionError(f"Bifrost tools/call error: {envelope['error']}")
        return envelope.get("result", {})

    @staticmethod
    def _parse_rpc(resp: httpx.Response) -> dict[str, Any]:
        ctype = resp.headers.get("content-type", "")
        if "text/event-stream" in ctype:
            for line in resp.text.splitlines():
                line = line.strip()
                if line.startswith("data:"):
                    chunk = line[len("data:"):].strip()
                    if chunk and chunk != "[DONE]":
                        return json.loads(chunk)
            return {}
        return resp.json()
