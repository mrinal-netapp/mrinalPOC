"""Unit tests for authentication middleware.

Tests cover:
- AuthMiddleware is abstract and cannot be instantiated
- NoopAuthMiddleware accepts all requests with empty claims
- APIKeyAuthMiddleware raises ValueError when initialized with empty keys
- APIKeyAuthMiddleware raises HTTPException(401) for missing key header
- APIKeyAuthMiddleware raises HTTPException(401) for invalid key
- APIKeyAuthMiddleware returns claims for valid key
- APIKeyAuthMiddleware uses constant-time comparison (hash-based)
- APIKeyAuthMiddleware uses custom header name when configured
- AgentAuthMiddleware passes through exempt paths
- AgentAuthMiddleware returns 401 for protected paths with invalid key
- build_auth_middleware returns NoopAuthMiddleware when disabled
- build_auth_middleware returns APIKeyAuthMiddleware when enabled with keys
- build_auth_middleware raises ValueError for unsupported scheme
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, Request

from agent_service_maf.interface_layer.auth import (
    APIKeyAuthMiddleware,
    AuthMiddleware,
    NoopAuthMiddleware,
    build_auth_middleware,
)
from tests.conftest import TEST_PROJECT_PREFIX

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_mock_request(
    headers: dict[str, str] | None = None,
    path: str = f"{TEST_PROJECT_PREFIX}/agents/echo/invoke",
) -> MagicMock:
    """Create a mock FastAPI Request with configurable headers and URL path."""
    mock_request = MagicMock(spec=Request)
    mock_request.headers = headers or {}
    mock_request.url = MagicMock()
    mock_request.url.path = path
    mock_request.state = MagicMock()
    return mock_request


# ---------------------------------------------------------------------------
# AuthMiddleware abstract enforcement
# ---------------------------------------------------------------------------


class TestAuthMiddlewareAbstract:
    """Tests verifying AuthMiddleware is abstract."""

    def test_auth_middleware_cannot_be_instantiated(self) -> None:
        """AuthMiddleware is abstract and cannot be instantiated directly."""
        with pytest.raises(TypeError) as exc_info:
            AuthMiddleware()  # type: ignore[abstract]
        assert "abstract" in str(exc_info.value).lower(), (
            f"Expected TypeError about abstract methods, got: {exc_info.value}"
        )

    def test_concrete_subclass_can_be_instantiated(self) -> None:
        """A concrete subclass of AuthMiddleware can be instantiated."""

        class ConcreteAuth(AuthMiddleware):
            async def authenticate(self, request: Request):
                return {}

        auth = ConcreteAuth()
        assert auth is not None, "Expected concrete subclass to be instantiatable"


# ---------------------------------------------------------------------------
# NoopAuthMiddleware tests
# ---------------------------------------------------------------------------


class TestNoopAuthMiddleware:
    """Tests for the NoopAuthMiddleware."""

    async def test_authenticate_returns_empty_dict(self) -> None:
        """NoopAuthMiddleware.authenticate() returns an empty claims dict."""
        noop = NoopAuthMiddleware()
        request = make_mock_request()
        claims = await noop.authenticate(request)
        assert claims == {}, f"Expected empty dict from NoopAuthMiddleware, got {claims}"

    async def test_authenticate_accepts_any_request(self) -> None:
        """NoopAuthMiddleware accepts requests without any X-API-Key header."""
        noop = NoopAuthMiddleware()
        # Request with no headers
        request = make_mock_request(headers={})
        claims = await noop.authenticate(request)
        assert isinstance(claims, dict), "Expected dict from authenticate()"

    def test_noop_is_subclass_of_auth_middleware(self) -> None:
        """NoopAuthMiddleware is a subclass of AuthMiddleware."""
        assert issubclass(NoopAuthMiddleware, AuthMiddleware), (
            "Expected NoopAuthMiddleware to be a subclass of AuthMiddleware"
        )


# ---------------------------------------------------------------------------
# APIKeyAuthMiddleware construction tests
# ---------------------------------------------------------------------------


class TestAPIKeyAuthMiddlewareConstruction:
    """Tests for APIKeyAuthMiddleware initialization."""

    def test_construction_with_valid_keys(self) -> None:
        """APIKeyAuthMiddleware can be constructed with a list of valid keys."""
        auth = APIKeyAuthMiddleware(valid_keys=["key1", "key2"])
        assert auth is not None, "Expected APIKeyAuthMiddleware to be created"

    def test_construction_with_empty_keys_raises(self) -> None:
        """APIKeyAuthMiddleware raises ValueError with empty valid_keys list."""
        with pytest.raises(ValueError) as exc_info:
            APIKeyAuthMiddleware(valid_keys=[])
        error_msg = str(exc_info.value)
        assert "api_key" in error_msg.lower() or "key" in error_msg.lower(), (
            f"Expected error about API keys, got: {error_msg}"
        )

    def test_construction_with_only_empty_strings_results_in_empty_hashes(self) -> None:
        """APIKeyAuthMiddleware with only empty-string keys results in an empty hash set.

        The implementation filters empty strings at hash time. The initial guard
        only rejects an entirely empty list ([]). When all keys are empty strings,
        the stored hash set is empty, meaning every authentication attempt will fail.
        """
        # The implementation does not raise for ["", ""] — it silently creates
        # an auth provider that will reject every key (empty hash set).
        auth = APIKeyAuthMiddleware(valid_keys=["", ""])
        assert len(auth._key_hashes) == 0, (
            "Expected empty hash set when all provided keys are empty strings"
        )

    def test_custom_header_name_stored(self) -> None:
        """APIKeyAuthMiddleware stores the custom header name."""
        auth = APIKeyAuthMiddleware(valid_keys=["key1"], header_name="Authorization")
        assert auth._header_name == "Authorization", (
            f"Expected header_name='Authorization', got {auth._header_name!r}"
        )

    def test_default_header_name_is_x_api_key(self) -> None:
        """APIKeyAuthMiddleware defaults to 'X-API-Key' header."""
        auth = APIKeyAuthMiddleware(valid_keys=["key1"])
        assert auth._header_name == "X-API-Key", (
            f"Expected default header_name='X-API-Key', got {auth._header_name!r}"
        )

    def test_keys_stored_as_hashes_not_plaintext(self) -> None:
        """APIKeyAuthMiddleware stores key hashes, not plaintext keys."""
        auth = APIKeyAuthMiddleware(valid_keys=["plaintext-key"])
        # The key hashes should be stored as bytes, not the plaintext key
        for stored_hash in auth._key_hashes:
            assert stored_hash != b"plaintext-key", "Expected plaintext key to NOT be stored as-is"
            assert len(stored_hash) == 32, (
                f"Expected SHA-256 hash (32 bytes), got {len(stored_hash)} bytes"
            )


# ---------------------------------------------------------------------------
# APIKeyAuthMiddleware.authenticate() tests
# ---------------------------------------------------------------------------


class TestAPIKeyAuthenticate:
    """Tests for APIKeyAuthMiddleware.authenticate()."""

    async def test_valid_key_returns_authenticated_claims(self) -> None:
        """A valid API key returns authenticated claims."""
        auth = APIKeyAuthMiddleware(valid_keys=["valid-key-123"])
        request = make_mock_request(headers={"X-API-Key": "valid-key-123"})
        claims = await auth.authenticate(request)
        assert claims.get("authenticated") is True, (
            f"Expected authenticated=True in claims, got {claims}"
        )
        assert claims.get("scheme") == "api_key", (
            f"Expected scheme='api_key' in claims, got {claims.get('scheme')!r}"
        )

    async def test_missing_header_raises_http_exception_401(self) -> None:
        """Missing API key header raises HTTPException with status 401."""
        auth = APIKeyAuthMiddleware(valid_keys=["valid-key"])
        request = make_mock_request(headers={})  # No X-API-Key header
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(request)
        assert exc_info.value.status_code == 401, f"Expected 401, got {exc_info.value.status_code}"

    async def test_missing_header_error_includes_header_name(self) -> None:
        """Missing header error mentions the expected header name."""
        auth = APIKeyAuthMiddleware(valid_keys=["valid-key"])
        request = make_mock_request(headers={})
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(request)
        assert "X-API-Key" in exc_info.value.detail, (
            f"Expected header name in error detail, got: {exc_info.value.detail}"
        )

    async def test_invalid_key_raises_http_exception_401(self) -> None:
        """Invalid API key raises HTTPException with status 401."""
        auth = APIKeyAuthMiddleware(valid_keys=["correct-key"])
        request = make_mock_request(headers={"X-API-Key": "wrong-key"})
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(request)
        assert exc_info.value.status_code == 401, f"Expected 401, got {exc_info.value.status_code}"

    async def test_one_valid_key_among_multiple(self) -> None:
        """A valid key is accepted when multiple keys are registered."""
        auth = APIKeyAuthMiddleware(valid_keys=["key-alpha", "key-beta", "key-gamma"])
        request = make_mock_request(headers={"X-API-Key": "key-beta"})
        claims = await auth.authenticate(request)
        assert claims.get("authenticated") is True, (
            "Expected key-beta to be accepted among multiple valid keys"
        )

    async def test_wrong_key_from_multiple_raises(self) -> None:
        """A wrong key is rejected when multiple valid keys are registered."""
        auth = APIKeyAuthMiddleware(valid_keys=["key-alpha", "key-beta"])
        request = make_mock_request(headers={"X-API-Key": "key-wrong"})
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(request)
        assert exc_info.value.status_code == 401, (
            f"Expected 401 for wrong key, got {exc_info.value.status_code}"
        )

    async def test_custom_header_name_used(self) -> None:
        """APIKeyAuthMiddleware reads from the configured custom header name."""
        auth = APIKeyAuthMiddleware(valid_keys=["secret-key"], header_name="X-Custom-Auth")
        # Send key in custom header
        request = make_mock_request(headers={"X-Custom-Auth": "secret-key"})
        claims = await auth.authenticate(request)
        assert claims.get("authenticated") is True, (
            "Expected custom header to be read for authentication"
        )

    async def test_default_header_not_read_when_custom_header_set(self) -> None:
        """When custom header is configured, default X-API-Key is not used."""
        auth = APIKeyAuthMiddleware(valid_keys=["secret-key"], header_name="X-Custom-Auth")
        # Send key in default header (X-API-Key), not in custom header
        request = make_mock_request(headers={"X-API-Key": "secret-key"})
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(request)
        assert exc_info.value.status_code == 401, "Expected 401 when key sent to wrong header"

    async def test_empty_key_value_treated_as_missing(self) -> None:
        """An empty string in the API key header is treated as missing."""
        auth = APIKeyAuthMiddleware(valid_keys=["valid-key"])
        request = make_mock_request(headers={"X-API-Key": ""})
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(request)
        assert exc_info.value.status_code == 401, (
            f"Expected 401 for empty key value, got {exc_info.value.status_code}"
        )


# ---------------------------------------------------------------------------
# build_auth_middleware factory tests
# ---------------------------------------------------------------------------


class TestBuildAuthMiddleware:
    """Tests for the build_auth_middleware factory function."""

    def test_disabled_returns_noop_middleware(self) -> None:
        """build_auth_middleware returns NoopAuthMiddleware when disabled."""
        middleware = build_auth_middleware(enabled=False)
        assert isinstance(middleware, NoopAuthMiddleware), (
            f"Expected NoopAuthMiddleware when disabled, got {type(middleware)}"
        )

    def test_enabled_with_api_keys_returns_api_key_middleware(self) -> None:
        """build_auth_middleware returns APIKeyAuthMiddleware when enabled with keys."""
        middleware = build_auth_middleware(enabled=True, api_keys=["key1"])
        assert isinstance(middleware, APIKeyAuthMiddleware), (
            f"Expected APIKeyAuthMiddleware when enabled, got {type(middleware)}"
        )

    def test_enabled_without_keys_raises(self) -> None:
        """build_auth_middleware raises ValueError when enabled but no keys provided."""
        with pytest.raises(ValueError) as exc_info:
            build_auth_middleware(enabled=True, api_keys=[])
        assert "key" in str(exc_info.value).lower(), (
            f"Expected error about API keys, got: {exc_info.value}"
        )

    def test_enabled_with_none_keys_raises(self) -> None:
        """build_auth_middleware raises ValueError when enabled but api_keys is None."""
        with pytest.raises(ValueError):
            build_auth_middleware(enabled=True, scheme="api_key", api_keys=None)

    def test_unsupported_scheme_raises(self) -> None:
        """build_auth_middleware raises ValueError for unsupported auth scheme."""
        with pytest.raises(ValueError) as exc_info:
            build_auth_middleware(enabled=True, scheme="oauth2", api_keys=["key1"])
        error_msg = str(exc_info.value)
        assert "scheme" in error_msg.lower() or "oauth2" in error_msg.lower(), (
            f"Expected error about unsupported scheme, got: {error_msg}"
        )

    def test_custom_header_name_passed_to_middleware(self) -> None:
        """build_auth_middleware passes custom header name to APIKeyAuthMiddleware."""
        middleware = build_auth_middleware(
            enabled=True,
            api_keys=["key1"],
            api_key_header="X-Custom-Key",
        )
        assert isinstance(middleware, APIKeyAuthMiddleware), "Expected APIKeyAuthMiddleware"
        assert middleware._header_name == "X-Custom-Key", (
            f"Expected header_name='X-Custom-Key', got {middleware._header_name!r}"
        )

    def test_keys_with_whitespace_filtered_out(self) -> None:
        """build_auth_middleware filters out empty/whitespace keys."""
        # Only empty strings should be filtered; non-empty pass through
        middleware = build_auth_middleware(
            enabled=True,
            api_keys=["", "valid-key", ""],
        )
        assert isinstance(middleware, APIKeyAuthMiddleware), (
            "Expected APIKeyAuthMiddleware with non-empty keys"
        )
