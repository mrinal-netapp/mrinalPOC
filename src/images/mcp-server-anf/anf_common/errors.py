"""Typed exceptions raised by anf_common.AnfClient."""
from __future__ import annotations

from typing import Optional


class AnfError(Exception):
    """Base class for all ANF ARM client errors."""

    code: str = "PROVIDER_ERROR"

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        hint: Optional[str] = None,
    ):
        super().__init__(message)
        self.message = message
        self.status = status
        self.hint = hint


class AnfAuthError(AnfError):
    """401 / 403 from Azure Resource Manager."""

    code = "UNAUTHORIZED"


class AnfValidationError(AnfError):
    """Client-side validation before PATCH."""

    code = "VALIDATION_ERROR"


class AnfHTTPError(AnfError):
    """Non-success status from ARM that was not classified more specifically."""

    code = "PROVIDER_ERROR"
