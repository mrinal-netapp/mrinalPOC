"""Unit tests for §F1+F2 BifrostClient identity-propagation headers.

Covers test plan item I8 — Bifrost identity-propagation knobs work as
documented:

* Authorization always carries the Bifrost service-account token (never
  replaced by the user JWT).
* When ``forward_user_identity=True`` (default) and an identity is
  bound, attribution headers (X-User-ID, X-Project-ID, etc.) are added.
* When ``forward_user_identity=False`` no attribution headers leak.
* When ``forward_user_token=True`` the user JWT is mirrored on
  X-User-Token; otherwise it is NEVER on any outbound header.
* No identity bound -> only Content-Type + Authorization (back-compat).
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.identity import (
    IdentityContext,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.gateway.http_llm_client import BifrostClient


@pytest.fixture
def identity() -> IdentityContext:
    return IdentityContext(
        user_id="alice",
        project_id="proj-123",
        user_email="alice@example.com",
        user_name="Alice Smith",
        user_token="raw-user-jwt-value",
        correlation_id="corr-xyz",
    )


class TestBifrostIdentityHeaders:
    """§I8 -- Bifrost identity propagation contract."""

    def test_no_identity_bound_minimal_headers(self) -> None:
        client = BifrostClient(
            api_base="https://bifrost.example/v1",
            api_key="sk-bifrost-1234",
        )
        headers = client._build_headers()
        assert headers == {
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-bifrost-1234",
        }

    def test_default_knobs_forward_attribution_not_token(self, identity: IdentityContext) -> None:
        client = BifrostClient(api_base="https://bifrost.example/v1", api_key="sk-bf")
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        # Service-account token still owns the Authorization slot.
        assert headers["Authorization"] == "Bearer sk-bf"
        # Attribution headers populated.
        assert headers["X-User-ID"] == "alice"
        assert headers["X-Project-ID"] == "proj-123"
        assert headers["X-User-Email"] == "alice@example.com"
        assert headers["X-User-Name"] == "Alice Smith"
        assert headers["X-Correlation-ID"] == "corr-xyz"
        # User JWT NOT forwarded by default.
        assert "X-User-Token" not in headers, "user_token leaked by default knob configuration"

    def test_forward_user_identity_false_no_attribution_headers(
        self, identity: IdentityContext
    ) -> None:
        client = BifrostClient(
            api_base="https://bifrost.example/v1",
            api_key="sk-bf",
            forward_user_identity=False,
        )
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        for hdr in ("X-User-ID", "X-Project-ID", "X-User-Email", "X-User-Name", "X-Correlation-ID"):
            assert hdr not in headers, f"unexpected header {hdr} when forwarding disabled"
        assert headers["Authorization"] == "Bearer sk-bf"

    def test_forward_user_token_true_mirrors_user_jwt(self, identity: IdentityContext) -> None:
        client = BifrostClient(
            api_base="https://bifrost.example/v1",
            api_key="sk-bf",
            forward_user_token=True,
        )
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        assert headers["X-User-Token"] == "raw-user-jwt-value"
        # Authorization still carries the service token (never the user JWT).
        assert headers["Authorization"] == "Bearer sk-bf"

    def test_authorization_never_replaced_by_user_jwt(self, identity: IdentityContext) -> None:
        """Both knobs on -> the user JWT goes on X-User-Token, never Authorization."""
        client = BifrostClient(
            api_base="https://bifrost.example/v1",
            api_key="sk-bf",
            forward_user_identity=True,
            forward_user_token=True,
        )
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        assert headers["Authorization"] == "Bearer sk-bf"
        assert "raw-user-jwt-value" not in headers["Authorization"]
        assert headers["X-User-Token"] == "raw-user-jwt-value"

    def test_empty_api_key_omits_authorization(self, identity: IdentityContext) -> None:
        """When BIFROST_API_KEY is unset (some deployments rely on network policy)."""
        client = BifrostClient(api_base="https://bifrost.example/v1", api_key="")
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        assert "Authorization" not in headers
        # Attribution headers still emitted (deployment may rely on them
        # for upstream observability).
        assert headers["X-User-ID"] == "alice"

    def test_optional_identity_fields_omitted_when_empty(self) -> None:
        identity = IdentityContext(user_id="alice")  # only user_id set
        client = BifrostClient(api_base="https://bifrost.example/v1", api_key="sk-bf")
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        assert headers["X-User-ID"] == "alice"
        for hdr in ("X-Project-ID", "X-User-Email", "X-User-Name", "X-Correlation-ID"):
            assert hdr not in headers, f"unexpected empty field header {hdr}"

    def test_user_token_never_present_when_knob_off(self, identity: IdentityContext) -> None:
        """Belt-and-suspenders: even with identity bound + knob off, no leak."""
        client = BifrostClient(
            api_base="https://bifrost.example/v1",
            api_key="sk-bf",
            forward_user_token=False,
        )
        tok = set_current_identity(identity)
        try:
            headers = client._build_headers()
        finally:
            reset_current_identity(tok)

        for value in headers.values():
            assert "raw-user-jwt-value" not in value, (
                f"user_token leaked into header value: {value!r}"
            )
