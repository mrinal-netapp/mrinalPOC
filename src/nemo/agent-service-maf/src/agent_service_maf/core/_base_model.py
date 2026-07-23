"""Common Pydantic base for wire-facing models.

Every response (and request) model that ships JSON to / from clients
inherits from :class:`CamelCaseModel`. Python attribute names stay in
``snake_case`` for PEP 8 / idiomatic Python; the wire form is emitted
in ``camelCase`` via Pydantic's ``alias_generator=to_camel`` config
and consumed in either form via ``populate_by_name=True``.

This is the foundation for the §5.2 "camelCase on the wire" lock-in
from the AgentStudio / agent-service-maf migration plan. One change in
this file flips the convention for every model that inherits from it.

Lives under :mod:`agent_service_maf.core` rather than
:mod:`agent_service_maf.interface_layer` to avoid circular imports --
``core.interfaces`` needs the base class but the interface-layer
package eagerly imports models that depend on ``core.interfaces``
during ``__init__``.

Re-exported from :mod:`agent_service_maf.interface_layer._base_model`
for backward compatibility with the original §5.2.1 plan file path.

Example:
    >>> from pydantic import Field
    >>> class Foo(CamelCaseModel):
    ...     session_id: str
    ...     duration_ms: int = Field(default=0)
    >>> Foo(session_id="abc").model_dump(by_alias=True)
    {'sessionId': 'abc', 'durationMs': 0}
    >>> Foo.model_validate({"sessionId": "abc"}).session_id
    'abc'
    >>> Foo.model_validate({"session_id": "abc"}).session_id
    'abc'
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelCaseModel(BaseModel):
    """Base class for every wire-facing Pydantic model.

    Configured so that:

    - Python attributes stay ``snake_case``.
    - JSON output (``model_dump(by_alias=True)`` / FastAPI serialization)
      emits ``camelCase`` field names.
    - JSON input is accepted under either form (``snake_case`` or
      ``camelCase``), allowing gradual consumer migration.

    Inherit from this in place of :class:`pydantic.BaseModel` for any
    model that crosses the HTTP / SSE / WebSocket boundary.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )
