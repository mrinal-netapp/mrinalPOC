"""Typed exceptions raised by ontap_common.OntapClient.

Adapter / MCP code should map these to user-facing error envelopes:

  OntapAuthError       -> code: "UNAUTHORIZED"      (401/403)
  OntapTLSVerifyError  -> code: "TLS_VERIFY_FAILED" (requests.SSLError)
  OntapTimeoutError    -> code: "TIMEOUT"           (read/connect timeout)
  OntapNetworkError    -> code: "PROVIDER_ERROR"    (DNS, connection refused)
  OntapHTTPError       -> code: "PROVIDER_ERROR"    (5xx, unexpected 4xx)
  OntapError           -> code: "PROVIDER_ERROR"    (anything else)
"""
from __future__ import annotations

from typing import Optional


class OntapError(Exception):
    """Base class for all ONTAP client errors."""

    code: str = "PROVIDER_ERROR"

    def __init__(self, message: str, *, status: Optional[int] = None, hint: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.hint = hint


class OntapAuthError(OntapError):
    """401 / 403 from the ONTAP REST API."""

    code = "UNAUTHORIZED"


class OntapTLSVerifyError(OntapError):
    """TLS certificate verification failed (self-signed or wrong CA)."""

    code = "TLS_VERIFY_FAILED"

    def __init__(
        self,
        message: str = "ONTAP TLS verification failed",
        *,
        hint: str = (
            "Set verify_tls=false on the connector or supply ca_bundle_pem in the credential."
        ),
    ):
        super().__init__(message, hint=hint)


class OntapTimeoutError(OntapError):
    """Connect / read timeout."""

    code = "TIMEOUT"


class OntapNetworkError(OntapError):
    """DNS failure, connection refused, etc."""

    code = "PROVIDER_ERROR"


class OntapHTTPError(OntapError):
    """Non-success status code from ONTAP that we did not classify more specifically."""

    code = "PROVIDER_ERROR"
