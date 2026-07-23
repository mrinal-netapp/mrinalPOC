"""JSON-Schema validation of structured agent output.

Thin wrapper around :class:`jsonschema.Draft7Validator` so the agent-service
suites can assert that an agent's ``parsedOutput`` (or any decoded output)
conforms to the JSON Schema the agent was created with.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft7Validator


def schema_errors(instance: Any, schema: dict[str, Any]) -> list[str]:
    """Return human-readable validation errors for ``instance`` against ``schema``.

    Function use:
        Validates a decoded output value against a JSON Schema and collects
        every validation error message, in document order. An empty list means
        the instance matches the schema.

    Input:
        instance (Any): The decoded output to validate (e.g. ``parsedOutput``).
        schema (dict[str, Any]): The JSON Schema to validate against.

    Output:
        list[str]: Validation error messages; empty when the instance is valid.
    """
    validator = Draft7Validator(schema)
    return [error.message for error in validator.iter_errors(instance)]


def assert_output_matches_schema(instance: Any, schema: dict[str, Any]) -> None:
    """Assert ``instance`` conforms to ``schema``; raise ``AssertionError`` if not.

    Function use:
        Convenience assertion for tests: fails with the collected validation
        errors when the output does not match the schema.

    Input:
        instance (Any): The decoded output to validate (e.g. ``parsedOutput``).
        schema (dict[str, Any]): The JSON Schema to validate against.

    Output:
        None
    """
    errors = schema_errors(instance, schema)
    assert not errors, f"output does not match schema: {errors}"
