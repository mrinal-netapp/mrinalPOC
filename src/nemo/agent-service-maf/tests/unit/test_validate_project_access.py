"""Unit tests for §C1 validate_project_access helper (test plan I1).

Exercises the three rules of §3 of the plan + the dev / no-auth fallback:

* Rule 1: X-Project-ID present and != URL ``{project_id}`` → 403.
* Rule 2: X-Project-ID empty → URL wins (mutates the identity copy on
  request.state.claims).
* Rule 3: resource_project_id != URL → 403.
* No identity bound → synthesizes one from _resolve_user_id + URL.
* Structlog audit fields bound on success (user_id, project_id,
  correlation_id) — verified via the contextvar dict.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
import structlog
from fastapi import HTTPException

from agent_service_maf.core.identity import IdentityContext
from agent_service_maf.interface_layer.routes import validate_project_access


class _FakeRequest:
    """Minimal Request stand-in: only ``.state`` (with named attributes)
    and ``.headers`` are read by validate_project_access / _resolve_user_id.

    SimpleNamespace is used for state so undefined attributes raise the
    way getattr expects -- a MagicMock would auto-create them and feed
    junk values into the synthetic IdentityContext.
    """

    def __init__(
        self,
        *,
        claims: Any = None,
        headers: dict[str, str] | None = None,
        user_id: str | None = None,
    ) -> None:
        self.state = SimpleNamespace()
        if claims is not None:
            self.state.claims = claims
        if user_id is not None:
            self.state.user_id = user_id
        self.headers = headers or {}


def _request(
    claims: Any = None,
    headers: dict[str, str] | None = None,
    user_id: str | None = None,
) -> _FakeRequest:
    return _FakeRequest(claims=claims, headers=headers, user_id=user_id)


@pytest.fixture(autouse=True)
def _clear_contextvars() -> Any:
    """Drop any structlog contextvars set by previous tests."""
    structlog.contextvars.clear_contextvars()
    yield
    structlog.contextvars.clear_contextvars()


class TestRule1HeaderMismatch:
    """X-Project-ID present and != URL -> 403."""

    def test_mismatch_raises_403(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity, "sub": "alice"})
        with pytest.raises(HTTPException) as exc_info:
            validate_project_access(request, url_project_id="proj-B")
        assert exc_info.value.status_code == 403
        detail = exc_info.value.detail
        assert isinstance(detail, dict)
        assert detail["error"] == "Project access denied"
        assert detail["detail"]["urlProjectId"] == "proj-B"
        assert detail["detail"]["headerProjectId"] == "proj-A"

    def test_match_returns_identity_untouched(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity})
        out = validate_project_access(request, url_project_id="proj-A")
        assert out is identity  # same instance, no copy needed
        assert out.user_id == "alice"
        assert out.project_id == "proj-A"


class TestRule2URLFillsEmptyHeader:
    """X-Project-ID empty -> URL wins; identity copy written back."""

    def test_empty_header_filled_from_url(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="")
        claims = {"_identity": identity}
        request = _request(claims=claims)
        out = validate_project_access(request, url_project_id="proj-X")

        assert out.project_id == "proj-X"
        assert out.user_id == "alice"
        # Original identity is frozen-unchanged.
        assert identity.project_id == ""
        # Updated copy is rebound onto claims for downstream readers.
        assert claims["_identity"] is out
        assert request.state.claims is claims


class TestRule3ResourceProjectMismatch:
    """resource_project_id != URL -> 403."""

    def test_resource_mismatch_raises_403(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity})
        with pytest.raises(HTTPException) as exc_info:
            validate_project_access(
                request,
                url_project_id="proj-A",
                resource_project_id="proj-B",
            )
        assert exc_info.value.status_code == 403
        detail = exc_info.value.detail
        assert isinstance(detail, dict)
        assert detail["error"] == "Resource does not belong to this project"
        assert detail["detail"]["urlProjectId"] == "proj-A"
        assert detail["detail"]["resourceProjectId"] == "proj-B"

    def test_resource_match_returns_identity(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity})
        out = validate_project_access(
            request,
            url_project_id="proj-A",
            resource_project_id="proj-A",
        )
        assert out is identity

    def test_resource_none_passes(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity})
        out = validate_project_access(request, "proj-A", resource_project_id=None)
        assert out is identity

    def test_resource_empty_string_passes(self) -> None:
        """Falsy resource_project_id is treated as "no constraint"."""
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity})
        out = validate_project_access(request, "proj-A", resource_project_id="")
        assert out is identity


class TestNoIdentitySynthesisFromFallback:
    """No bound identity (dev / no-auth / test) -> synthesize from
    _resolve_user_id and the URL project."""

    def test_no_claims_synthesizes_from_header(self) -> None:
        request = _request(claims=None, headers={"x-user-id": "dev-user"})
        out = validate_project_access(request, url_project_id="proj-A")
        assert isinstance(out, IdentityContext)
        assert out.user_id == "dev-user"
        assert out.project_id == "proj-A"
        # Synthetic identity has no user_token by design.
        assert out.user_token is None

    def test_no_user_id_and_no_claims_uses_empty_string(self) -> None:
        request = _request(claims=None, headers={})
        out = validate_project_access(request, url_project_id="proj-A")
        assert out.user_id == ""
        assert out.project_id == "proj-A"

    def test_claims_dict_without_identity_synthesizes(self) -> None:
        """claims['sub'] without an _identity entry still synthesizes."""
        request = _request(
            claims={"sub": "alice", "authenticated": True},
            headers={},
        )
        out = validate_project_access(request, url_project_id="proj-A")
        # _resolve_user_id reads claims['sub'].
        assert out.user_id == "alice"
        assert out.project_id == "proj-A"


class TestStructlogContextvarsBinding:
    """§H2 -- per-request audit breadcrumbs bound on success."""

    def test_user_id_project_id_correlation_id_bound(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id="proj-A",
            correlation_id="corr-xyz",
        )
        request = _request(claims={"_identity": identity})
        validate_project_access(request, url_project_id="proj-A")

        bound = structlog.contextvars.get_contextvars()
        assert bound["user_id"] == "alice"
        assert bound["project_id"] == "proj-A"
        assert bound["correlation_id"] == "corr-xyz"

    def test_user_email_user_name_never_bound(self) -> None:
        """PII fields stay off the per-task log envelope by design."""
        identity = IdentityContext(
            user_id="alice",
            project_id="proj-A",
            user_email="alice@example.com",
            user_name="Alice Smith",
            user_token="raw-jwt",
        )
        request = _request(claims={"_identity": identity})
        validate_project_access(request, url_project_id="proj-A")

        bound = structlog.contextvars.get_contextvars()
        assert "user_email" not in bound
        assert "user_name" not in bound
        assert "user_token" not in bound

    def test_no_binding_on_403_path(self) -> None:
        """A denied request must NOT leave stale identity envelope behind."""
        # Explicitly pre-set so the negative is meaningful.
        structlog.contextvars.bind_contextvars(user_id="someone-else")
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        request = _request(claims={"_identity": identity})
        with pytest.raises(HTTPException):
            validate_project_access(request, url_project_id="proj-B")

        bound = structlog.contextvars.get_contextvars()
        # The pre-existing entry is NOT clobbered with alice's identity --
        # bind only happens on the success path after rule checks pass.
        assert bound.get("user_id") == "someone-else"
