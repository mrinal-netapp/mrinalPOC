"""JSON-Schema → Pydantic v2 model builder for output-schema validation.

This module powers the **Option B** output-schema validation path
described in ``docs/spec/MigrationToNewRepo/maf-output-schema-validation-plan.md``.
It walks a JSON Schema dict and synthesises a :class:`pydantic.BaseModel`
class at runtime via :func:`pydantic.create_model`. The class is then
used to validate the LLM's parsed output and produce a typed dict for
:attr:`agent_service_maf.interface_layer.models.InvokeResponse.parsed_output`.

Ported essentially verbatim from the legacy
``src/nemo/agent-service/src/agent_factory.py:77-142`` helpers so the
MAF behaviour matches what the AgentStudio service has been doing in
production for months.

Supported JSON Schema subset
----------------------------

The same narrow vocabulary the legacy code accepts is honoured here:

* ``type: "string" | "integer" | "number" | "boolean" | "array" | "object" | "null"``
* ``properties`` on objects (recursive)
* ``required: [...]`` array (otherwise fields default to ``Optional[T] = None``)
* ``items`` on arrays (recursive — produces ``list[T]``)
* ``$ref`` resolution against ``definitions`` / ``$defs`` (siblings
  at the schema root)
* ``title`` on nested objects (used as the synthesised model class
  name; a random suffix is appended otherwise)

Anything else degrades gracefully:

* Unsupported root type → :func:`build_outcome_model` returns ``None``
  and the caller falls back to "no validation" mode.
* Unsupported keywords inside a property (``oneOf``, ``anyOf``,
  ``enum``, ``pattern``, ``minimum``, ``maximum``, ``format``, ...)
  are ignored. The field's type collapses to ``dict`` (object-like)
  or ``str`` (fallback) — same behaviour as legacy.
* Unknown ``$ref`` → ``dict``.

Caching
-------

Two in-process caches keyed by the SHA-256 fingerprint of a
canonicalised JSON serialisation of the schema:

* ``_OUTCOME_MODEL_CACHE`` — successful build results (size 256, LRU
  via :class:`collections.OrderedDict`).
* ``_BUILD_FAILURE_CACHE`` — fingerprints known to fail. Skipped on
  subsequent calls so a malformed schema doesn't spam the WARNING log
  on every invocation.

Both caches are process-local and thread-safe under the GIL (the only
mutations are ``__setitem__`` / ``move_to_end`` on the OrderedDict
which are atomic in CPython).
"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from collections import OrderedDict
from typing import Any, Optional

import structlog
from pydantic import BaseModel, ConfigDict, create_model

# ``X | None`` is the modern PEP-604 spelling. We keep an explicit
# ``Optional`` alias because :func:`pydantic.create_model` accepts a
# subscripted ``Optional`` consistently across Pydantic v2 minor
# releases, whereas ``T | None`` requires the runtime to support
# ``types.UnionType`` field tuples. The alias is a no-op when read by
# the linter — it just makes the intent visible at the call site.
_OptionalT = Optional  # noqa: UP045  -- intentional, see comment above

logger = structlog.get_logger(__name__)

#: Default LRU cache size. Sized for a typical "one schema per agent"
#: deployment with headroom for ~256 distinct agents.
_DEFAULT_CACHE_SIZE = 256

#: Cap on the number of cached build failures. Bounded so a hostile
#: client cannot exhaust memory by sending an unbounded stream of
#: distinct malformed schemas.
_DEFAULT_FAILURE_CACHE_SIZE = 1024

#: Map of legacy JSON-Schema ``type`` strings → Python types.
#: Ported verbatim from legacy ``agent_factory.py``.
JSON_SCHEMA_TYPE_MAP: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
    "null": type(None),
}


# ---------------------------------------------------------------------------
# Caches
# ---------------------------------------------------------------------------

_cache_lock = threading.Lock()
_OUTCOME_MODEL_CACHE: OrderedDict[str, type[BaseModel]] = OrderedDict()
_BUILD_FAILURE_CACHE: OrderedDict[str, None] = OrderedDict()


def schema_fingerprint(schema: dict[str, Any]) -> str:
    """Return a deterministic SHA-256 fingerprint of ``schema``.

    The fingerprint is computed against the canonical JSON serialisation
    (``sort_keys=True``, no extraneous whitespace). Two schemas that
    differ only in key ordering produce the same fingerprint, which is
    what the cache wants: callers shouldn't pay for schema parsing twice
    just because their dict literal happened to spell keys in a
    different order.

    Args:
        schema: The JSON Schema dict to fingerprint.

    Returns:
        Lowercase 64-character hex SHA-256 digest. Stable across
        process restarts.

    Raises:
        TypeError: If ``schema`` contains values that are not
            JSON-serialisable. This is a programmer error — callers
            should hand in plain ``dict`` / ``list`` / primitive trees.
    """
    canonical = json.dumps(schema, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cache_get_model(fingerprint: str) -> type[BaseModel] | None:
    """LRU-aware lookup: hit → move to most-recent end, miss → ``None``."""
    with _cache_lock:
        model = _OUTCOME_MODEL_CACHE.get(fingerprint)
        if model is not None:
            _OUTCOME_MODEL_CACHE.move_to_end(fingerprint)
        return model


def _cache_put_model(fingerprint: str, model: type[BaseModel]) -> None:
    """LRU-aware insert with eviction of the oldest entry when full."""
    with _cache_lock:
        _OUTCOME_MODEL_CACHE[fingerprint] = model
        _OUTCOME_MODEL_CACHE.move_to_end(fingerprint)
        while len(_OUTCOME_MODEL_CACHE) > _DEFAULT_CACHE_SIZE:
            _OUTCOME_MODEL_CACHE.popitem(last=False)


def _cache_record_failure(fingerprint: str) -> None:
    """Insert a build failure with eviction of the oldest entry when full."""
    with _cache_lock:
        _BUILD_FAILURE_CACHE[fingerprint] = None
        _BUILD_FAILURE_CACHE.move_to_end(fingerprint)
        while len(_BUILD_FAILURE_CACHE) > _DEFAULT_FAILURE_CACHE_SIZE:
            _BUILD_FAILURE_CACHE.popitem(last=False)


def _cache_has_failure(fingerprint: str) -> bool:
    with _cache_lock:
        if fingerprint in _BUILD_FAILURE_CACHE:
            _BUILD_FAILURE_CACHE.move_to_end(fingerprint)
            return True
        return False


def cache_status_snapshot() -> dict[str, int]:
    """Return a snapshot of the cache occupancy for observability.

    Returns:
        A dict with ``size`` (current entry count), ``max_size``
        (configured ceiling), and ``build_failure_count`` (entries in
        the failure-skip cache).
    """
    with _cache_lock:
        return {
            "size": len(_OUTCOME_MODEL_CACHE),
            "max_size": _DEFAULT_CACHE_SIZE,
            "build_failure_count": len(_BUILD_FAILURE_CACHE),
        }


def _clear_caches() -> None:
    """Empty both caches. Intended for unit tests only."""
    with _cache_lock:
        _OUTCOME_MODEL_CACHE.clear()
        _BUILD_FAILURE_CACHE.clear()


# ---------------------------------------------------------------------------
# Schema → Pydantic model conversion
# ---------------------------------------------------------------------------


def _resolve_field_type(
    prop: dict[str, Any],
    definitions: dict[str, Any] | None = None,
) -> Any:  # noqa: ANN401
    """Map one JSON-Schema property to a Python type.

    Mirrors the legacy ``_resolve_field_type`` so the produced types
    match what AgentStudio has been generating from the same schemas.

    Args:
        prop: A single ``properties[name]`` value or an ``items``
            value.
        definitions: Sibling ``definitions`` / ``$defs`` map for
            ``$ref`` resolution. Optional; missing refs degrade to
            ``dict``.

    Returns:
        A Python type usable as the second element of the tuple
        ``create_model`` expects.
    """
    if "$ref" in prop:
        ref_path = str(prop["$ref"]).split("/")[-1]
        if definitions and ref_path in definitions:
            return _resolve_field_type(definitions[ref_path], definitions)
        return dict

    schema_type = prop.get("type", "string")
    if schema_type == "array":
        items = prop.get("items", {})
        if items and isinstance(items, dict):
            item_type = _resolve_field_type(items, definitions)
            return list[item_type]
        return list
    if schema_type == "object":
        if prop.get("properties"):
            return _build_nested_model(prop, definitions)
        return dict
    return JSON_SCHEMA_TYPE_MAP.get(schema_type, str)


#: ``extra="allow"`` mirrors JSON Schema's default semantics for
#: object-typed schemas: properties not listed in ``properties`` are
#: permitted unless the schema explicitly sets
#: ``additionalProperties: false`` (which the supported subset does
#: not honour — out of scope). Pydantic's default
#: ``extra="ignore"`` would silently drop those extras and produce a
#: surprising ``model_dump()`` for callers who hand in a permissive
#: schema like ``{"type": "object"}``.
_PERMISSIVE_OBJECT_CONFIG = ConfigDict(extra="allow")


def _build_nested_model(
    schema: dict[str, Any],
    definitions: dict[str, Any] | None = None,
) -> type[BaseModel]:
    """Synthesise a Pydantic v2 model from an object schema.

    Required fields use ``...`` as the default (Pydantic's "no
    default" marker); optional fields default to ``None`` with
    ``Optional[T]`` typing.

    The synthesised model uses ``extra="allow"`` so a permissive
    schema (e.g. ``{"type": "object"}`` with no ``properties``)
    preserves any keys the LLM emitted instead of dropping them.
    This matches the legacy AgentStudio behaviour and JSON Schema's
    default "additional properties allowed unless explicitly
    forbidden" semantics.

    Args:
        schema: The object-typed schema to convert.
        definitions: Sibling refs map for nested ``$ref`` resolution.

    Returns:
        A new Pydantic ``BaseModel`` subclass.

    Raises:
        TypeError / ValueError: When :func:`pydantic.create_model`
            rejects the synthesised field tuples (e.g., an invalid
            field name). Caller (the public
            :func:`build_outcome_model`) catches and records the
            failure.
    """
    title = str(schema.get("title") or f"Model_{uuid.uuid4().hex[:8]}")
    properties = schema.get("properties", {}) or {}
    required = set(schema.get("required", []) or [])
    fields: dict[str, tuple[Any, Any]] = {}
    for name, prop in properties.items():
        if not isinstance(prop, dict):
            # Defensive: a non-dict property is unrepresentable. Treat
            # as an unconstrained optional field to keep the model
            # buildable; the validator would have rejected it anyway.
            fields[name] = (_OptionalT[Any], None)
            continue
        field_type = _resolve_field_type(prop, definitions)
        if name in required:
            fields[name] = (field_type, ...)
        else:
            fields[name] = (_OptionalT[field_type], None)
    return create_model(
        title,
        __config__=_PERMISSIVE_OBJECT_CONFIG,
        **fields,
    )


def _build_outcome_model_uncached(schema: dict[str, Any]) -> type[BaseModel]:
    """Drive the recursive build for a top-level schema.

    Args:
        schema: A JSON-Schema-shaped dict. Must be object-typed at the
            root: either declare ``type == "object"`` or include a
            ``properties`` map. Non-object roots are rejected per the
            module's documented behaviour ("Unsupported root type →
            ``build_outcome_model`` returns ``None``"), so a schema like
            ``{"type": "string"}`` does not silently produce a
            permissive object model.

    Returns:
        A new Pydantic ``BaseModel`` subclass representing ``schema``.

    Raises:
        ValueError: When the root is not an object schema.
        TypeError / RecursionError: Anything Pydantic / recursion can
            throw. Caller catches and records the failure in the
            build-failure cache.
    """
    root_type = schema.get("type")
    if root_type is None:
        if not isinstance(schema.get("properties"), dict):
            raise ValueError(
                "Root schema is not a valid object schema: declare "
                "type == 'object' or include a 'properties' map."
            )
    elif root_type != "object":
        raise ValueError(f"Unsupported root schema type {root_type!r}: only 'object' is supported.")
    definitions_raw = schema.get("definitions") or schema.get("$defs") or {}
    definitions = definitions_raw if isinstance(definitions_raw, dict) else {}
    return _build_nested_model(schema, definitions)


def build_outcome_model(schema: dict[str, Any]) -> type[BaseModel] | None:
    """Build (or fetch from cache) a Pydantic v2 model for ``schema``.

    The result is cached by SHA-256 fingerprint of the canonicalised
    schema. Repeated calls with the same shape (regardless of dict key
    ordering) return the **same** class object — identity check via
    ``id()`` is a valid cache-hit assertion in tests.

    A schema that fails to build is recorded in a separate
    "failure" cache so subsequent calls return ``None`` immediately
    without re-attempting construction or re-emitting the WARNING log.

    Args:
        schema: The JSON Schema dict to convert. ``None`` and
            non-dict inputs short-circuit to ``None``.

    Returns:
        The dynamically-constructed model class on success, or
        ``None`` when the schema is empty, not a dict, or its
        construction raised. Callers should treat ``None`` as
        "validation unavailable, proceed without it" (silent-fail
        mode per the plan §3 #8).
    """
    if not schema or not isinstance(schema, dict):
        return None

    try:
        fingerprint = schema_fingerprint(schema)
    except (TypeError, ValueError) as exc:
        logger.warning(
            "outcome_model_build_failed",
            error_type=type(exc).__name__,
            error=str(exc)[:200],
            schema_top_keys=sorted([str(k) for k in schema])[:10],
            reason="fingerprint_failed",
        )
        return None

    if _cache_has_failure(fingerprint):
        return None

    cached = _cache_get_model(fingerprint)
    if cached is not None:
        return cached

    try:
        model = _build_outcome_model_uncached(schema)
    except Exception as exc:  # noqa: BLE001 — degrades gracefully
        logger.warning(
            "outcome_model_build_failed",
            error_type=type(exc).__name__,
            error=str(exc)[:200],
            schema_top_keys=sorted([str(k) for k in schema])[:10],
            fingerprint=fingerprint[:16],
        )
        _cache_record_failure(fingerprint)
        return None

    _cache_put_model(fingerprint, model)
    return model
