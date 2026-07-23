"""FastAPI interface layer — REST, SSE, and WebSocket endpoints.

This package provides:
- :func:`~agent_service_maf.interface_layer.api.create_app`: FastAPI app factory.
- :mod:`~agent_service_maf.interface_layer.routes`: Route handlers.
- :mod:`~agent_service_maf.interface_layer.models`: API request/response models.
- :mod:`~agent_service_maf.interface_layer.auth`: Authentication middleware.
- :mod:`~agent_service_maf.interface_layer.error_formatter`: Safe error formatting.
- :mod:`~agent_service_maf.interface_layer.sse_handler`: SSE streaming handler.
- :mod:`~agent_service_maf.interface_layer.ws_handler`: WebSocket handler.

Note:
    ``create_app`` is not imported at module level to avoid triggering FastAPI route
    registration during testing. Import directly when needed:
    ``from agent_service_maf.interface_layer.api import create_app``.
"""

from agent_service_maf.interface_layer.auth import (
    APIKeyAuthMiddleware,
    AuthMiddleware,
    NoopAuthMiddleware,
    build_auth_middleware,
)
from agent_service_maf.interface_layer.error_formatter import SafeErrorFormatter
from agent_service_maf.interface_layer.models import (
    AgentListResponse,
    ErrorResponse,
    HealthResponse,
    InvokeRequest,
    InvokeResponse,
)

__all__ = [
    "AuthMiddleware",
    "APIKeyAuthMiddleware",
    "NoopAuthMiddleware",
    "build_auth_middleware",
    "SafeErrorFormatter",
    "InvokeRequest",
    "InvokeResponse",
    "ErrorResponse",
    "AgentListResponse",
    "HealthResponse",
]
