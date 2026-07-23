"""Managed MCP server creation request model for config-service.

A single object holding every field needed to create a managed (catalog) MCP
server via ``POST /api/v1/projects/{projectId}/mcp-servers``. ``to_body()``
renders the camelCase payload with ``deploymentType: "managed"`` and wraps the
env overrides under ``managedConfig``.

Note: config-service constrains the MCP server ``name`` to
``^[a-zA-Z0-9_]+$`` (alphanumeric + underscores, no hyphens), so callers must
supply an underscore-only name.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ManagedMcpServerRequest:
    """Inputs for a config-service managed MCP-server create call.

    Required: ``name`` (underscore-only), ``catalog_id`` and
    ``runtime_credential_id`` (the credential whose ``provider`` matches the
    catalog entry's ``credentialMapping.expectedProvider``). ``env_overrides``
    are projected into the managed pod; ``description`` is optional.
    """

    name: str
    catalog_id: str
    runtime_credential_id: str
    env_overrides: dict[str, str] = field(default_factory=dict)
    description: str | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase create-MCP-server request body.

        Function use:
            Assembles the JSON payload for creating a managed catalog MCP
            server, wrapping ``env_overrides`` under ``managedConfig`` and
            omitting ``description`` when unset.

        Input:
            None

        Output:
            dict[str, Any]: The create-MCP-server request body.
        """
        body: dict[str, Any] = {
            "name": self.name,
            "deploymentType": "managed",
            "catalogId": self.catalog_id,
            "runtimeCredentialId": self.runtime_credential_id,
            "managedConfig": {"envOverrides": self.env_overrides},
        }
        if self.description is not None:
            body["description"] = self.description
        return body
