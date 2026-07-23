"""Guardrail system for the agent framework.

This package provides composable, async guardrails for validating and sanitising
agent input, output, and tool calls.

Quick start:

.. code-block:: python

    from agent_service_maf.guardrails import GuardrailPipeline, GuardrailRegistry
    from agent_service_maf.config.validators import AgentConfig

    config = AgentConfig()
    pipeline = GuardrailRegistry.build_pipeline(config.guardrails, agent_id="my-agent")
    safe_input = await pipeline.check_input("Hello!", agent_id="my-agent")

Package structure:

.. code-block:: text

    guardrails/
    ├── base.py         — GuardrailContext, GuardrailResult, GuardrailAction, ABCs, resolve_action
    ├── pipeline.py     — GuardrailPipeline (orchestrates check_input/output/tool)
    ├── registry.py     — GuardrailRegistry (decorator registration, build_pipeline)
    └── catalog/        — one module per guardrail identity (phase chosen in team JSON)
        ├── pii_masker.py        — PIIDetector + PIIMasker (input + output)
        ├── content_filter.py    — Secret/credential detection (input + output)
        ├── input_validator.py   — Length and format validation (input)
        ├── prompt_injection.py  — Regex-based injection detection (input)
        ├── schema_validator.py  — JSON schema and required field validation (output)
        ├── output_length.py     — Max character limit enforcement (output)
        ├── tool_authorizer.py   — ToolAuthorizer + ToolCallCounter (tool)
        ├── param_validator.py   — Path traversal and shell injection detection (tool)
        └── tool_result_guard.py — Injection detection in MCP tool results (input)
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Import the catalog package to trigger every @register_* decorator. This must
# happen AFTER registry is imported to avoid circular imports.
# ---------------------------------------------------------------------------
from agent_service_maf.guardrails import catalog as _catalog_package  # noqa: F401
from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    OutputGuardrail,
    ToolGuardrail,
)
from agent_service_maf.guardrails.pipeline import GuardrailPipeline
from agent_service_maf.guardrails.registry import GuardrailRegistry

__all__ = [
    "GuardrailAction",
    "GuardrailContext",
    "GuardrailPipeline",
    "GuardrailRegistry",
    "GuardrailResult",
    "InputGuardrail",
    "OutputGuardrail",
    "ToolGuardrail",
]
