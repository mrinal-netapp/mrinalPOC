"""Unit tests for §A4 attachment validation.

Mirrors the legacy AgentStudio caps:

- ``MAX_ATTACHMENTS = 5`` -- per-request item count.
- ``MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024`` (5 MB) -- per-item raw size.

The validator runs before the adapter sees the request, so it raises
``fastapi.HTTPException`` directly with structured details. We pin the
status codes exactly:

- 400 ``Too many attachments`` when len > 5.
- 400 ``Attachment content is not valid base64`` on decode failure.
- 413 ``Attachment exceeds N MB limit`` when any item > 5 MB.
"""

from __future__ import annotations

import base64

import pytest
from fastapi import HTTPException

from agent_service_maf.interface_layer._attachments import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    validate_attachments,
)
from agent_service_maf.interface_layer.models import AttachmentItem


def _b64(payload: bytes) -> str:
    return base64.b64encode(payload).decode("ascii")


def _item(
    name: str = "a.bin", size: int = 16, mime: str = "application/octet-stream"
) -> AttachmentItem:
    return AttachmentItem(filename=name, mime_type=mime, content=_b64(b"x" * size))


class TestValidateAttachments:
    def test_none_is_noop(self) -> None:
        validate_attachments(None)  # must not raise

    def test_empty_list_is_noop(self) -> None:
        validate_attachments([])

    def test_within_limits_passes(self) -> None:
        # 5 items, each tiny
        validate_attachments([_item(f"f{i}.bin") for i in range(MAX_ATTACHMENTS)])

    def test_too_many_attachments_rejects_400(self) -> None:
        items = [_item(f"f{i}.bin") for i in range(MAX_ATTACHMENTS + 1)]
        with pytest.raises(HTTPException) as exc:
            validate_attachments(items)
        assert exc.value.status_code == 400
        detail = exc.value.detail
        assert isinstance(detail, dict)
        assert "Too many attachments" in detail["error"]
        assert detail["details"]["count"] == MAX_ATTACHMENTS + 1

    def test_exact_max_passes(self) -> None:
        items = [_item(f"f{i}.bin") for i in range(MAX_ATTACHMENTS)]
        validate_attachments(items)

    def test_oversized_attachment_rejects_413(self) -> None:
        big = _item("big.bin", size=MAX_ATTACHMENT_BYTES + 1)
        with pytest.raises(HTTPException) as exc:
            validate_attachments([big])
        assert exc.value.status_code == 413
        detail = exc.value.detail
        assert isinstance(detail, dict)
        assert "5 MB" in detail["error"]
        assert detail["details"]["attachment"] == "big.bin"
        assert detail["details"]["sizeBytes"] == MAX_ATTACHMENT_BYTES + 1

    def test_exact_max_size_passes(self) -> None:
        boundary = _item("boundary.bin", size=MAX_ATTACHMENT_BYTES)
        validate_attachments([boundary])

    def test_invalid_base64_rejects_400(self) -> None:
        bad = AttachmentItem(
            filename="bad.bin",
            mime_type="application/octet-stream",
            content="!!!not-base64@@@",
        )
        with pytest.raises(HTTPException) as exc:
            validate_attachments([bad])
        assert exc.value.status_code == 400
        detail = exc.value.detail
        assert isinstance(detail, dict)
        assert "not valid base64" in detail["error"]
        assert detail["details"]["attachment"] == "bad.bin"

    def test_max_count_and_max_bytes_constants(self) -> None:
        assert MAX_ATTACHMENTS == 5, "Per-request cap is locked to 5 (§A4)"
        assert MAX_ATTACHMENT_BYTES == 5 * 1024 * 1024, "Per-item cap is locked to 5 MB (§A4)"
