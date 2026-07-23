"""Default configuration values for the agent framework.

``DEFAULTS`` is the baseline configuration dictionary used by
:class:`~agent_service_maf.config.config_loader.ConfigLoader` as the starting
point before any env-var, JSON-file, or request-level overrides are applied.

The dictionary is auto-generated from Pydantic model defaults via
:func:`_extract_defaults`, so it stays in sync with the schema automatically.
The guardrail defaults that require explicit non-empty values (e.g. the default
guardrail rule list) are merged on top of the auto-generated baseline.

Usage:
    ``AgentConfig(**DEFAULTS)`` MUST pass Pydantic validation without errors.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from agent_service_maf.config.validators import AgentConfig


def _extract_defaults(model_class: type[BaseModel]) -> dict[str, Any]:
    """Recursively extract default values from a Pydantic model class.

    For each field in the model:
    - If the field has a sub-model type, recurse into it.
    - Otherwise, use the field's default value or call ``default_factory``.

    This ensures that ``DEFAULTS`` stays in sync with the schema
    automatically — no hand-maintained copies of default values.

    Args:
        model_class: A Pydantic ``BaseModel`` subclass to extract defaults from.

    Returns:
        A plain dict representing the model's default values.
    """
    result: dict[str, Any] = {}
    for field_name, field_info in model_class.model_fields.items():
        annotation = field_info.annotation

        # Unwrap Optional[X] → X
        origin = getattr(annotation, "__origin__", None)
        args: tuple[Any, ...] = getattr(annotation, "__args__", ())
        if origin is type(None):  # bare None type — skip
            continue

        # Check if this is a sub-model (has model_fields attribute)
        actual_type: Any = annotation
        if origin is not None and args:
            # For Optional[X] / Union[X, None], pick the first non-None arg
            non_none = [a for a in args if a is not type(None)]
            if non_none:
                actual_type = non_none[0]

        if isinstance(actual_type, type) and issubclass(actual_type, BaseModel):
            result[field_name] = _extract_defaults(actual_type)
        else:
            # Use the field default
            if field_info.default is not None and field_info.default is not ...:
                value: Any = field_info.default
                # Copy lists to avoid sharing references
                if isinstance(value, list):
                    value = list(value)
                result[field_name] = value
            else:
                factory = field_info.default_factory
                if factory is not None:
                    result[field_name] = factory()  # type: ignore[call-arg]
            # else: no default → skip (required field, not expected here)

    return result


def _build_defaults() -> dict[str, Any]:
    """Build the DEFAULTS dict from auto-generated schema defaults.

    Content guardrails (input/output) are intentionally left empty so they are
    OPT-IN — only the rules a team/agent config explicitly declares will run
    (parity with the prior Agno/SK behavior). The only non-empty override is the
    tool policy, which must be set to a permissive ``denylist`` because the schema
    default (``allowlist`` with no tools) would otherwise block every tool.

    Returns:
        The complete DEFAULTS dict that passes ``AgentConfig(**DEFAULTS)``.
    """
    base = _extract_defaults(AgentConfig)

    # Guardrails are OPT-IN: content guardrails apply only when a team/agent config
    # explicitly lists them (parity with the prior Agno/SK behavior). We therefore
    # leave ``input_guardrails`` / ``output_guardrails`` empty here; the
    # config-service team blob is the single source of truth for which guardrails
    # run, and ``deep_merge`` replaces these lists when the team specifies its own.
    base["guardrails"]["input_guardrails"] = []
    base["guardrails"]["output_guardrails"] = []
    # Tool policy must stay PERMISSIVE by default: the schema default for ToolPolicy
    # is ``mode="allowlist"`` with an empty ``tools`` list, which would block EVERY
    # tool. A ``denylist`` with no entries allows all tools (still capped per
    # request) so agents can call tools unless a team opts into a stricter policy.
    base["guardrails"]["tool_guardrails"] = {
        "mode": "denylist",
        "tools": [],
        "max_calls_per_request": 20,
    }

    # Agent-definition section: override the auto-extracted defaults that
    # cannot handle list[BaseModel] fields correctly. (Key name retained for
    # back-compat; the schema is framework-agnostic.)
    base["semantic_kernel"] = {
        "agents": [{"name": "default", "instructions": "", "description": ""}],
        "orchestration": {"type": "single"},
        "default_function_choice_behavior": "auto",
        "chat_history_max_messages": 100,
        "enable_telemetry": False,
        "enable_sensitive_telemetry": False,
        "session_ttl_seconds": 3600,
    }

    return base


#: Baseline configuration dictionary.
#:
#: This is the starting point before any env-var, JSON-file, or
#: request-level overrides are applied by
#: :class:`~agent_service_maf.config.config_loader.ConfigLoader`.
#:
#: The dict is built once at import time from Pydantic model defaults
#: (via :func:`_extract_defaults`) so it automatically stays in sync
#: with the schema.  Guardrail rule lists are then patched with explicit
#: production-ready defaults (see :func:`_build_defaults`).
#:
#: Assertion: ``AgentConfig(**DEFAULTS)`` passes validation without errors.
DEFAULTS: dict[str, Any] = _build_defaults()
