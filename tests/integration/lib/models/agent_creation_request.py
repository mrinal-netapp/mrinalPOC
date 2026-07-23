"""Agent creation request model for config-service.

A single object holding every field needed to create an agent via
``POST /api/v1/projects/{projectId}/agents``. ``to_body()`` renders the
camelCase payload (per config-service spec), omitting unset (``None``) fields
so the same model serves both the instantiation suite (no memory) and the
memory suite (with ``memoryType`` / ``memoryConfig`` / ``memoryContext``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class AgentCreationRequest:
    """Inputs for a config-service ``CreateAgentRequest``.

    Required: ``name``, ``role``, ``system_prompt`` plus at least one of
    ``model_id`` / ``model_class``. Memory fields are optional and only
    included in the body when set.
    """

    name: str
    role: str
    system_prompt: str
    description: str | None = None
    model_id: str | None = None
    model_class: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    knowledge_base_ids: list[str] | None = None
    rag_config: dict[str, Any] | None = None
    memory_type: str | None = None
    memory_config: dict[str, Any] | None = None
    memory_context: dict[str, Any] | None = None
    guardrails: dict[str, Any] | None = None
    mcp_server_ids: list[str] | None = None
    function_choice_behavior: str | None = None
    structured_output: dict[str, Any] | None = None

    def to_body(self) -> dict[str, Any]:
        """Render the camelCase request body, omitting unset fields."""
        body: dict[str, Any] = {
            "name": self.name,
            "role": self.role,
            "systemPrompt": self.system_prompt,
        }
        if self.description is not None:
            body["description"] = self.description
        if self.model_id is not None:
            body["modelId"] = self.model_id
        if self.model_class is not None:
            body["modelClass"] = self.model_class
        if self.temperature is not None:
            body["temperature"] = self.temperature
        if self.max_tokens is not None:
            body["maxTokens"] = self.max_tokens
        if self.knowledge_base_ids is not None:
            body["knowledgeBaseIds"] = self.knowledge_base_ids
        if self.rag_config is not None:
            body["ragConfig"] = self.rag_config
        if self.memory_type is not None:
            body["memoryType"] = self.memory_type
        if self.memory_config is not None:
            body["memoryConfig"] = self.memory_config
        if self.memory_context is not None:
            body["memoryContext"] = self.memory_context
        if self.guardrails is not None:
            body["guardrails"] = self.guardrails
        if self.mcp_server_ids is not None:
            body["mcpServerIds"] = self.mcp_server_ids
        if self.function_choice_behavior is not None:
            body["functionChoiceBehavior"] = self.function_choice_behavior
        if self.structured_output is not None:
            body["structuredOutput"] = self.structured_output
        return body
