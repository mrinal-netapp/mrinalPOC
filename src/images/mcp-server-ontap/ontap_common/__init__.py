"""Shared NetApp ONTAP REST client + error helpers.

This package is the canonical source consumed by both the connector-worker
adapter (in-tree) and the mcp-server-ontap image (vendored copy at
src/images/mcp-server-ontap/ontap_common/). Keep the two copies in sync
when modifying.
"""
from .client import OntapClient, verify_tls_from_connector_config
from .errors import (
    OntapError,
    OntapAuthError,
    OntapTLSVerifyError,
    OntapHTTPError,
    OntapNetworkError,
    OntapTimeoutError,
)

__all__ = [
    "OntapClient",
    "verify_tls_from_connector_config",
    "OntapError",
    "OntapAuthError",
    "OntapTLSVerifyError",
    "OntapHTTPError",
    "OntapNetworkError",
    "OntapTimeoutError",
]
