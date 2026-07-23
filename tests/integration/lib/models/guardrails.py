"""Guardrails config builder for the agent-service guardrails suites.

Config-service stores the agent ``guardrails`` object verbatim (snake_case
JSONB); agent-service resolves each rule **by ``name``** and treats
``guardrail_id`` as opaque (it is accepted but ignored — there is no
catalog lookup/validation today). The IDs below are therefore the fixed
placeholders from the task spec; ``name`` + ``enabled`` are what drive
enforcement. Replace the IDs with resolved values once a real lookup exists.
"""

from __future__ import annotations

from typing import Any

# Hardcoded guardrail IDs (opaque to agent-service; resolution is by name).
INPUT_PII_MASKER_ID = "a3f8c2d1-9b4e-4f7a-8c2d-1e6b9f0a3c5d"
INPUT_CONTENT_FILTER_ID = "7d2e1a9c-4f63-4b8e-9a1d-2c7f5e8b0d36"
INPUT_SECRET_LEAKAGE_ID = "e91b6f4a-3c08-4d2b-bf7e-5a9c1d4e8027"

OUTPUT_PII_MASKER_ID = "c5a07e93-1d4f-42b6-8e0a-7b3c9f2d6148"
OUTPUT_CONTENT_FILTER_ID = "0f8d3b62-7e51-4a9c-b2d4-6e1a8c503f9b"
OUTPUT_SECRET_LEAKAGE_ID = "92c4e87a-5b16-4f03-8d9e-1a7c2b6f4d50"

# Guardrail catalog names (the field agent-service actually resolves on).
PII_MASKER = "pii_masker"
CONTENT_FILTER = "content_filter"
SECRET_LEAKAGE = "secret_leakage"


def guardrail_rule(guardrail_id: str, name: str, *, enabled: bool = True) -> dict[str, Any]:
    """Build a single guardrail rule entry (``{guardrail_id, name, enabled}``)."""
    return {"guardrail_id": guardrail_id, "name": name, "enabled": enabled}


def guardrails_config(
    *,
    input_rules: list[dict[str, Any]] | None = None,
    output_rules: list[dict[str, Any]] | None = None,
    enabled: bool = True,
    fail_open: bool = False,
    log_blocked_requests: bool = True,
) -> dict[str, Any]:
    """Build the top-level ``guardrails`` object for a create-agent body.

    Args:
        input_rules: Rules applied to user input (pre-model). Defaults to ``[]``.
        output_rules: Rules applied to model output (post-model). Defaults to ``[]``.
        enabled: Master switch for the card.
        fail_open: ``False`` blocks the turn when a guardrail check errors.
        log_blocked_requests: Emit a log entry whenever a request is blocked.

    Returns:
        A snake_case dict ready to assign to ``AgentCreationRequest.guardrails``.
    """
    return {
        "enabled": enabled,
        "fail_open": fail_open,
        "log_blocked_requests": log_blocked_requests,
        "input_guardrails": list(input_rules or []),
        "output_guardrails": list(output_rules or []),
    }
