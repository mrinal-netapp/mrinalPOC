"""Agent invoke request model for agent-service.

A single object holding every field needed to invoke an agent (or team) via
``POST /api/v1/projects/{projectId}/agents/{agentId}/invoke`` (and the team
equivalent). ``to_body()`` renders the camelCase payload (per agent-service
spec), omitting unset (``None``) fields so the same model serves plain invokes
as well as invokes carrying ``configOverrides`` / ``context`` / ``metadata``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AgentInvocationRequest:
    """Inputs for an agent-service ``InvokeRequest``.

    Required: ``input``. Everything else is optional and only included in the
    body when set, mirroring the loose-validation invoke contract.
    """

    input: str
    session_id: str | None = None
    config_overrides: dict[str, Any] | None = None
    context: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    attachments: list[dict[str, Any]] | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase request body, omitting unset fields."""
        body: dict[str, Any] = {"input": self.input}
        if self.session_id is not None:
            body["sessionId"] = self.session_id
        if self.config_overrides is not None:
            body["configOverrides"] = self.config_overrides
        if self.context is not None:
            body["context"] = self.context
        if self.metadata is not None:
            body["metadata"] = self.metadata
        if self.attachments is not None:
            body["attachments"] = self.attachments
        return body
