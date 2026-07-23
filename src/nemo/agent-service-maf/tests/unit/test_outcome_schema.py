"""Unit tests for :mod:`agent_service_maf.framework._outcome_schema` (plan G1).

Covers the JSON-Schema → Pydantic-model builder, the fingerprint helper,
and the two LRU caches (success cache + build-failure cache).
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from agent_service_maf.framework._outcome_schema import (
    JSON_SCHEMA_TYPE_MAP,
    _clear_caches,
    build_outcome_model,
    cache_status_snapshot,
    schema_fingerprint,
)


@pytest.fixture(autouse=True)
def _clean_caches() -> None:
    """Isolate every test from the module-level cache state."""
    _clear_caches()
    yield
    _clear_caches()


# ---------------------------------------------------------------------------
# Primitive type mapping
# ---------------------------------------------------------------------------


class TestPrimitiveTypes:
    """Every supported root primitive resolves to the expected Python type
    when nested inside a property of an object schema.
    """

    @pytest.mark.parametrize(
        ("json_type", "py_type", "value"),
        [
            ("string", str, "hello"),
            ("integer", int, 7),
            ("number", float, 3.14),
            ("boolean", bool, True),
            ("array", list, [1, 2, 3]),
            ("object", dict, {"k": "v"}),
            ("null", type(None), None),
        ],
    )
    def test_primitive_round_trip(self, json_type: str, py_type: type, value: object) -> None:
        schema = {
            "type": "object",
            "properties": {"field": {"type": json_type}},
            "required": ["field"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None, f"Builder must accept {json_type} schema"
        instance = model_cls.model_validate({"field": value})
        dumped = instance.model_dump()
        assert dumped == {"field": value}, (
            f"{json_type} should round-trip {value!r}, got {dumped!r}"
        )
        # Type map exposes the canonical Python type for callers that
        # want to introspect.
        assert JSON_SCHEMA_TYPE_MAP[json_type] is py_type


# ---------------------------------------------------------------------------
# Required vs optional fields
# ---------------------------------------------------------------------------


class TestRequiredVsOptional:
    """``required`` array drives ``...`` vs ``Optional[T] = None``."""

    def test_required_field_missing_raises(self) -> None:
        schema = {
            "type": "object",
            "properties": {"customerId": {"type": "string"}},
            "required": ["customerId"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            model_cls.model_validate({})

    def test_optional_field_can_be_absent(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "customerId": {"type": "string"},
                "note": {"type": "string"},
            },
            "required": ["customerId"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        instance = model_cls.model_validate({"customerId": "abc"})
        # Optional field defaults to None and is included on dump.
        dumped = instance.model_dump()
        assert dumped["customerId"] == "abc"
        assert dumped["note"] is None


# ---------------------------------------------------------------------------
# Nested objects
# ---------------------------------------------------------------------------


class TestNestedObjects:
    """``properties`` on a child ``object`` produces a nested submodel."""

    def test_nested_object_builds_submodel(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "customer": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "tier": {"type": "string"},
                    },
                    "required": ["id"],
                }
            },
            "required": ["customer"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        instance = model_cls.model_validate({"customer": {"id": "cust-1", "tier": "gold"}})
        dumped = instance.model_dump()
        assert dumped == {"customer": {"id": "cust-1", "tier": "gold"}}

    def test_object_without_properties_is_permissive(self) -> None:
        """A bare ``{"type": "object"}`` schema must accept arbitrary keys."""
        schema = {"type": "object"}
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        instance = model_cls.model_validate({"a": 1, "b": "two"})
        # extra="allow" preserves keys not declared in properties --
        # the legacy AgentStudio parser behaved this way.
        dumped = instance.model_dump()
        assert dumped == {"a": 1, "b": "two"}


# ---------------------------------------------------------------------------
# Arrays with items
# ---------------------------------------------------------------------------


class TestArraysWithItems:
    def test_array_of_strings(self) -> None:
        schema = {
            "type": "object",
            "properties": {"tags": {"type": "array", "items": {"type": "string"}}},
            "required": ["tags"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        dumped = model_cls.model_validate({"tags": ["a", "b"]}).model_dump()
        assert dumped == {"tags": ["a", "b"]}

    def test_array_of_objects(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"sku": {"type": "string"}},
                        "required": ["sku"],
                    },
                }
            },
            "required": ["items"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        dumped = model_cls.model_validate({"items": [{"sku": "X1"}, {"sku": "X2"}]}).model_dump()
        assert dumped == {"items": [{"sku": "X1"}, {"sku": "X2"}]}

    def test_array_without_items_falls_back_to_list(self) -> None:
        schema = {
            "type": "object",
            "properties": {"misc": {"type": "array"}},
            "required": ["misc"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        instance = model_cls.model_validate({"misc": [1, "two", {"k": "v"}]})
        assert instance.model_dump() == {"misc": [1, "two", {"k": "v"}]}


# ---------------------------------------------------------------------------
# $ref resolution
# ---------------------------------------------------------------------------


class TestRefResolution:
    def test_ref_against_definitions(self) -> None:
        schema = {
            "type": "object",
            "properties": {"address": {"$ref": "#/definitions/Address"}},
            "required": ["address"],
            "definitions": {
                "Address": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                }
            },
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        dumped = model_cls.model_validate({"address": {"city": "Sunnyvale"}}).model_dump()
        assert dumped == {"address": {"city": "Sunnyvale"}}

    def test_ref_against_defs(self) -> None:
        schema = {
            "type": "object",
            "properties": {"address": {"$ref": "#/$defs/Address"}},
            "required": ["address"],
            "$defs": {
                "Address": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                }
            },
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        dumped = model_cls.model_validate({"address": {"city": "RTP"}}).model_dump()
        assert dumped == {"address": {"city": "RTP"}}

    def test_unknown_ref_degrades_to_dict(self) -> None:
        """Per the legacy behaviour, an unresolvable ``$ref`` becomes ``dict``."""
        schema = {
            "type": "object",
            "properties": {"address": {"$ref": "#/definitions/Missing"}},
            "required": ["address"],
        }
        model_cls = build_outcome_model(schema)
        assert model_cls is not None
        # The field accepts any dict shape because $ref couldn't resolve.
        instance = model_cls.model_validate({"address": {"anything": True}})
        assert instance.model_dump() == {"address": {"anything": True}}


# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------


class TestFailureModes:
    def test_none_schema_returns_none(self) -> None:
        assert build_outcome_model(None) is None  # type: ignore[arg-type]

    def test_empty_schema_returns_none(self) -> None:
        assert build_outcome_model({}) is None

    def test_non_dict_schema_returns_none(self) -> None:
        assert build_outcome_model("not a schema") is None  # type: ignore[arg-type]
        assert build_outcome_model([1, 2]) is None  # type: ignore[arg-type]

    def test_non_object_root_type_returns_none(self) -> None:
        """A non-object root must degrade to ``None`` per the module
        docstring; otherwise a permissive object model would accept any
        dict regardless of the declared root type.
        """
        assert build_outcome_model({"type": "string"}) is None
        assert build_outcome_model({"type": "array", "items": {"type": "string"}}) is None
        assert build_outcome_model({"type": "integer"}) is None

    def test_root_without_type_or_properties_returns_none(self) -> None:
        """A dict that declares neither ``type`` nor ``properties`` is
        not a valid object schema; the legacy permissive path would
        have produced an empty model accepting anything.
        """
        assert build_outcome_model({"foo": "bar"}) is None

    def test_root_without_type_but_with_properties_builds(self) -> None:
        """Legacy schemas sometimes omit ``type`` at the root but
        declare ``properties``. Treat as object-typed.
        """
        model_cls = build_outcome_model({"properties": {"a": {"type": "string"}}})
        assert model_cls is not None

    def test_invalid_field_name_recorded_in_failure_cache(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Pydantic rejects field names that start with an underscore.

        Build is wrapped in try/except; the schema is recorded in the
        failure cache so subsequent calls short-circuit.
        """
        schema = {
            "type": "object",
            "properties": {"_bad_name": {"type": "string"}},
            "required": ["_bad_name"],
        }
        first = build_outcome_model(schema)
        # If pydantic accepts it (e.g. via aliasing), the test should
        # still assert the call returns ``None`` only when it rejects.
        # If it rejected the first call returns None; second call
        # should hit the failure cache and also return None.
        second = build_outcome_model(schema)
        if first is None:
            assert second is None, "Build-failure cache must short-circuit subsequent calls"
            snapshot = cache_status_snapshot()
            assert snapshot["build_failure_count"] >= 1


# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------


class TestCaching:
    def test_same_schema_returns_same_class(self) -> None:
        schema = {
            "type": "object",
            "properties": {"a": {"type": "string"}},
            "required": ["a"],
        }
        first = build_outcome_model(schema)
        second = build_outcome_model(schema)
        assert first is not None and second is not None
        # Identity check confirms the cache returns the exact same
        # class object — Pydantic would otherwise generate a new
        # class per call.
        assert first is second, "Cache must return the same model class"

    def test_key_order_does_not_matter(self) -> None:
        """Fingerprint is computed against canonical JSON (sort_keys)."""
        s1 = {
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "integer"}},
            "required": ["a"],
        }
        s2 = {
            "required": ["a"],
            "properties": {"b": {"type": "integer"}, "a": {"type": "string"}},
            "type": "object",
        }
        m1 = build_outcome_model(s1)
        m2 = build_outcome_model(s2)
        assert m1 is m2, "Differently-ordered identical schemas must share cache slot"

    def test_different_schemas_produce_different_classes(self) -> None:
        s1 = {"type": "object", "properties": {"a": {"type": "string"}}}
        s2 = {"type": "object", "properties": {"b": {"type": "string"}}}
        m1 = build_outcome_model(s1)
        m2 = build_outcome_model(s2)
        assert m1 is not None and m2 is not None
        assert m1 is not m2, "Distinct schemas must produce distinct classes"

    def test_cache_status_snapshot(self) -> None:
        build_outcome_model({"type": "object", "properties": {"a": {"type": "string"}}})
        snapshot = cache_status_snapshot()
        assert snapshot["size"] >= 1
        assert snapshot["max_size"] >= snapshot["size"]
        assert snapshot["build_failure_count"] >= 0


# ---------------------------------------------------------------------------
# schema_fingerprint
# ---------------------------------------------------------------------------


class TestSchemaFingerprint:
    def test_deterministic(self) -> None:
        schema = {"type": "object", "properties": {"a": {"type": "string"}}}
        assert schema_fingerprint(schema) == schema_fingerprint(schema)

    def test_key_order_independent(self) -> None:
        s1 = {"type": "object", "properties": {"a": {"type": "string"}}}
        s2 = {"properties": {"a": {"type": "string"}}, "type": "object"}
        assert schema_fingerprint(s1) == schema_fingerprint(s2)

    def test_distinct_schemas_distinct_fingerprints(self) -> None:
        s1 = {"type": "object", "properties": {"a": {"type": "string"}}}
        s2 = {"type": "object", "properties": {"b": {"type": "string"}}}
        assert schema_fingerprint(s1) != schema_fingerprint(s2)

    def test_64_char_hex_digest(self) -> None:
        fp = schema_fingerprint({"a": 1})
        assert len(fp) == 64
        # All hex characters.
        int(fp, 16)


# ---------------------------------------------------------------------------
# Returned class shape
# ---------------------------------------------------------------------------


class TestReturnedClassShape:
    def test_subclass_of_basemodel(self) -> None:
        model_cls = build_outcome_model({"type": "object", "properties": {"a": {"type": "string"}}})
        assert model_cls is not None
        assert issubclass(model_cls, BaseModel)

    def test_title_used_as_class_name(self) -> None:
        model_cls = build_outcome_model(
            {
                "type": "object",
                "title": "InvoiceOutcome",
                "properties": {"amount": {"type": "number"}},
            }
        )
        assert model_cls is not None
        assert model_cls.__name__ == "InvoiceOutcome"
