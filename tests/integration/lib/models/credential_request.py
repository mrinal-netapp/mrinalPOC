"""Credential creation request model for config-service.

A single object holding every field needed to create a credential via
``POST /api/v1/projects/{projectId}/credentials``. ``to_body()`` renders the
camelCase request payload (``secretData`` carries the provider secret and is
never echoed back by the API).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class CredentialCreateRequest:
    """Inputs for a config-service create-credential call.

    Required: ``name``, ``provider`` and ``secret_data``. ``metadata`` holds
    non-secret provider context (e.g. GCP project id / default region) and
    defaults to an empty object.
    """

    name: str
    provider: str
    secret_data: dict[str, Any]
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase create-credential request body.

        Function use:
            Assembles the JSON payload for creating a credential, mapping the
            secret payload to ``secretData`` as required by the config-service
            spec.

        Input:
            None

        Output:
            dict[str, Any]: The create-credential request body.
        """
        return {
            "name": self.name,
            "provider": self.provider,
            "secretData": self.secret_data,
            "metadata": self.metadata,
        }
