"""Remote MCP server creation request model for config-service.

A single object holding every field needed to create a remote (self-hosted /
externally supplied URL) MCP server via
``POST /api/v1/projects/{projectId}/mcp-servers``. ``to_body()`` renders the
camelCase payload with ``deploymentType: "remote"``.

Note: config-service constrains the MCP server ``name`` to
``^[a-zA-Z0-9_]+$`` (alphanumeric + underscores, no hyphens), so callers must
supply an underscore-only name.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class RemoteMcpServerRequest:
    """Inputs for a config-service remote MCP-server create call.

    Required: ``name`` (underscore-only) and ``url`` (the remote MCP endpoint).
    ``transport`` is one of ``http`` / ``sse`` / ``streamable-http`` (defaults
    to ``streamable-http``); ``auth_type`` defaults to ``none`` for an
    unauthenticated server. ``static_headers`` carries fixed request headers the
    gateway forwards to the MCP (e.g. ``{"x-api-key": "<key>"}`` for an
    API-key-authenticated server); ``description`` is optional.
    """

    name: str
    url: str
    transport: str = "streamable-http"
    auth_type: str = "none"
    static_headers: dict[str, str] = field(default_factory=dict)
    description: str | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase create-MCP-server request body.

        Function use:
            Assembles the JSON payload for creating a remote MCP server,
            emitting ``deploymentType: "remote"``, including ``staticHeaders``
            only when non-empty and omitting ``description`` when unset.

        Input:
            None

        Output:
            dict[str, Any]: The create-MCP-server request body.
        """
        body: dict[str, Any] = {
            "name": self.name,
            "deploymentType": "remote",
            "transport": self.transport,
            "url": self.url,
            "authType": self.auth_type,
        }
        if self.static_headers:
            body["staticHeaders"] = self.static_headers
        if self.description is not None:
            body["description"] = self.description
        return body
