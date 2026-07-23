"""Unit tests for MafAgentBuilder structured-output wiring.

Covers the build-time behaviour where a valid structuredOutput schema
(``output_schema``) drives the provider ``response_format``:

* valid ``output_schema``   -> response_format set to json_schema mode
* invalid ``output_schema`` -> dropped to None, no provider hint
* response_format=="json_object" alone -> no provider hint (legacy branch removed)
* no schema                 -> no provider hint
"""

from __future__ import annotations

from typing import Any

from agent_service_maf.config.validators import SKAgentDefinition
from agent_service_maf.framework.maf.agent_builder import MafAgentBuilder, friendly_model_label


class _FakeGateway:
    def __init__(self) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()


def _builder() -> MafAgentBuilder:
    return MafAgentBuilder(
        gateway=_FakeGateway(),  # type: ignore[arg-type]
        mcp_registry=None,
        default_model="azure/gpt-4.1-mini",
        default_temperature=0.0,
        default_max_tokens=1024,
    )


_VALID_SCHEMA: dict[str, Any] = {
    "type": "object",
    "title": "Answer",
    "properties": {
        "answer": {"type": "string"},
        "confidence": {"type": "string"},
    },
    "required": ["answer"],
}


def test_valid_output_schema_sets_json_schema_response_format() -> None:
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="be helpful",
        model="azure/gpt-4.1-mini",
        output_schema=_VALID_SCHEMA,
    )
    built = _builder().build_agent(agent_def)

    assert built.output_schema == _VALID_SCHEMA
    assert built.default_options.get("response_format") == {
        "type": "json_schema",
        "json_schema": {"name": "alpha", "schema": _VALID_SCHEMA},
    }


def test_invalid_output_schema_is_dropped() -> None:
    # Non-object root -> build_outcome_model returns None -> schema ignored.
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="be helpful",
        model="azure/gpt-4.1-mini",
        output_schema={"type": "string"},
    )
    built = _builder().build_agent(agent_def)

    assert built.output_schema is None
    assert "response_format" not in built.default_options


def test_json_object_alone_sets_no_provider_hint() -> None:
    # Legacy response_format=="json_object" branch was removed; only a valid
    # output_schema drives the provider response_format now.
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="be helpful",
        model="azure/gpt-4.1-mini",
        response_format="json_object",
    )
    built = _builder().build_agent(agent_def)

    assert built.output_schema is None
    assert "response_format" not in built.default_options
    # still cached on the wrapper for the adapter's expect_json derivation
    assert built.response_format == "json_object"


def test_no_structured_output_no_response_format() -> None:
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="be helpful",
        model="azure/gpt-4.1-mini",
    )
    built = _builder().build_agent(agent_def)

    assert built.output_schema is None
    assert "response_format" not in built.default_options


def test_manager_name_sanitized_does_not_leak_into_model_display_name() -> None:
    """A human-friendly ``manager_name`` with spaces is sanitized for the agent
    ``name``, but must NOT be copied into ``model_display_name``.

    Regression: the sanitize path set ``model_display_name = name`` whenever the
    name changed, leaking the agent label (e.g. "Triage Agent") into the model's
    provenance field. ``model_display_name`` is the *model* label fed to
    :func:`friendly_model_label` (citation ``model``), not an agent display name.
    """
    built = _builder().build_manager_agent(model="azure/gpt-4.1-mini", name="Triage Agent")

    # Agent name is sanitized to satisfy ^[a-zA-Z0-9_-]{1,64}$ ...
    assert built.name == "Triage-Agent"
    # ... but the model label is NOT the agent name; with none supplied it stays
    # None and the label falls back to the real model (provider prefix stripped).
    assert built.model_display_name is None
    label = friendly_model_label(built.model_display_name, built.model)
    assert label == "gpt-4.1-mini"
    assert label != "Triage Agent"


def test_manager_model_display_name_passed_through() -> None:
    """An explicitly supplied ``model_display_name`` (the registration label) is
    preserved and used as the model label."""
    built = _builder().build_manager_agent(
        model="azure/gpt-4.1-mini", name="Router", model_display_name="GPT-4.1 mini"
    )

    assert built.model_display_name == "GPT-4.1 mini"
    assert friendly_model_label(built.model_display_name, built.model) == "GPT-4.1 mini"
