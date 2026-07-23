"""Attachment validation helper.

Mirrors the legacy AgentStudio ``_validate_attachments`` from
``src/nemo/agent-service/src/main.py:1453`` and ports the two hard
limits the legacy service enforced before the request reached the
agent:

- ``_MAX_ATTACHMENTS = 5`` -- per-request item count cap.
- ``_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024`` -- per-item raw size cap
  (5 MB after base64 decode).

Both limits are deliberately constant module-level values so they
appear in OpenAPI / docs / error messages without indirection.
Override only by editing this module -- there is no per-request or
per-team knob today, and the legacy code did not expose one either.

Raises :class:`fastapi.HTTPException` directly so the route handler
just calls :func:`validate_attachments` once before constructing the
:class:`~agent_service_maf.core.interfaces.AgentRequest`.
"""

from __future__ import annotations

import base64
import binascii
from typing import TYPE_CHECKING

from fastapi import HTTPException

if TYPE_CHECKING:
    from collections.abc import Iterable

    from agent_service_maf.interface_layer.models import AttachmentItem

#: Maximum number of attachments accepted on a single request.
MAX_ATTACHMENTS: int = 5

#: Maximum decoded size in bytes for a single attachment (5 MiB).
MAX_ATTACHMENT_BYTES: int = 5 * 1024 * 1024


def validate_attachments(attachments: Iterable[AttachmentItem] | None) -> None:
    """Validate attachment count and per-item size.

    The base64 content is decoded eagerly to compute the real byte
    size; failures to decode produce a 400 with a clear error message
    so a client sending corrupt base64 is not silently passed through
    to the adapter.

    Args:
        attachments: Iterable of :class:`AttachmentItem` from the
            request body. ``None`` is a no-op.

    Raises:
        HTTPException:
            - 400 with structured detail when the list exceeds
              :data:`MAX_ATTACHMENTS` or any item carries
              non-base64 content.
            - 413 when any single item exceeds
              :data:`MAX_ATTACHMENT_BYTES`.
    """
    if not attachments:
        return

    items = list(attachments)
    if len(items) > MAX_ATTACHMENTS:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"Too many attachments (max {MAX_ATTACHMENTS})",
                "details": {"count": len(items)},
            },
        )

    for att in items:
        try:
            raw = base64.b64decode(att.content, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "Attachment content is not valid base64",
                    "details": {"attachment": att.filename, "reason": str(exc)},
                },
            ) from exc
        if len(raw) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=413,
                detail={
                    "error": (
                        f"Attachment exceeds {MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB limit"
                    ),
                    "details": {"attachment": att.filename, "sizeBytes": len(raw)},
                },
            )
