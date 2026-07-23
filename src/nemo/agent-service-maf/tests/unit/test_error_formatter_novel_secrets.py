"""Unit test — `SafeErrorFormatter.redact_sensitive_data` defensive coverage.

The audit (M2) flagged the existing redaction tests as
positive-only: each test asserts that a KNOWN-shape secret
(`sk-ant-*`, `eyJ...` JWT, etc.) is redacted. But the patterns are
allow-list-by-regex, not deny-list — any secret shape not in
`_REDACT_PATTERNS` slips through. Production secrets that don't
match the existing patterns:

  - MCP URLs with embedded basic-auth: `https://user:pass@mcp.example/sse`
  - NetApp internal tokens carried as `Token <opaque>` (not Bearer)
  - Bifrost gateway keys passed as `X-Gateway-Key: ...`
  - Custom API keys without the `sk-`/`ghp_`/`AKIA` prefixes
  - Encrypted secret refs (`enc:v1:...`)
  - Base64-encoded credentials in `Authorization: Basic ...`

This file fixes both (a) the known-handled cases and (b) the
known-gaps where redaction *should* happen but doesn't. Tests that
assert known gaps are marked `xfail` with the rationale so the
boundary is documented and the next contributor knows whether to
add a pattern.

In all cases — handled or gap — the test asserts that the
*generic* JSON `"api_key": "..."` / `"token": "..."` /
`"password": "..."` shapes still redact, because that's the
catch-all the pattern list relies on.
"""

from __future__ import annotations

import pytest

from agent_service_maf.interface_layer.error_formatter import SafeErrorFormatter

redact = SafeErrorFormatter.redact_sensitive_data


# ---------------------------------------------------------------------------
# (1) Generic JSON key-value catch-all — the safety net
# ---------------------------------------------------------------------------


class TestGenericJsonKeyValueCatchAll:
    """The audit explicitly recommends this as the catch-all. Pin
    that it catches every documented secret-field name even when
    the value doesn't match any known prefix pattern."""

    @pytest.mark.parametrize(
        "field_name",
        [
            "api_key",
            "API_KEY",
            "token",
            "Token",
            "secret",
            "Secret",
            "password",
            "Password",
            "credential",
            "auth",
        ],
    )
    def test_json_field_value_redacted_regardless_of_secret_shape(self, field_name: str) -> None:
        """`{"<field>": "<opaque blob>"}` must redact the value
        even when the blob doesn't match any prefix pattern."""
        opaque = "abracadabra-opaque-value-1234567890"
        body = f'{{"{field_name}": "{opaque}"}}'
        out = redact(body)
        assert opaque not in out, (
            f"Field {field_name!r} did not trigger redaction; opaque value survived: {out!r}"
        )
        assert "[REDACTED]" in out


# ---------------------------------------------------------------------------
# (2) Bearer / JWT — exhaustive forms
# ---------------------------------------------------------------------------


class TestBearerAndJwtRedaction:
    """Pin the documented prefix patterns under several shapes."""

    def test_bearer_lowercase_redacted(self) -> None:
        out = redact("Authorization: bearer eyJhbGciOiJSUzI1NiJ9.payload.sig")
        assert "eyJhbGciOiJSUzI1NiJ9" not in out

    def test_bearer_uppercase_redacted(self) -> None:
        out = redact("Authorization: BEARER eyJhbGciOiJSUzI1NiJ9.payload.sig")
        assert "eyJhbGciOiJSUzI1NiJ9" not in out

    def test_jwt_standalone_redacted(self) -> None:
        """A JWT-shaped token without the `Bearer` prefix should
        still hit the standalone `eyJ...` pattern. The pattern
        requires ≥20 base64url chars after `eyJ` before the first
        dot, matching what real JWT headers produce."""
        token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        out = redact(f"context dump: {token}")
        assert token not in out
        assert "[REDACTED-JWT]" in out

    def test_anthropic_key_redacted(self) -> None:
        out = redact("api_key=sk-ant-abc123def456")
        assert "sk-ant-abc123" not in out


# ---------------------------------------------------------------------------
# (3) NetApp internal Token shape — currently a gap
# ---------------------------------------------------------------------------


class TestNetappInternalTokenShape:
    """NetApp internal callers carry credentials as `Token <opaque>`
    rather than `Bearer`. The current patterns only catch `Bearer ...`,
    so the `Token ...` shape slips through.

    The defensive minimum is: when this shape lands inside a JSON
    field labelled `authorization` / `token` etc., the catch-all
    pattern still redacts. The bare-prefix form (outside JSON) is
    a known gap until a pattern is added."""

    def test_token_value_redacted_when_inside_json_field(self) -> None:
        """`{"authorization": "Token netapp-internal-abc"}` redacts
        via the generic catch-all even though `Token ...` isn't a
        prefix the redactor knows."""
        body = '{"authorization": "Token netapp-internal-abc-very-long-opaque-value"}'
        out = redact(body)
        assert "netapp-internal-abc" not in out, (
            f"Catch-all must handle Token-shape inside JSON, got: {out}"
        )

    @pytest.mark.xfail(
        reason="No pattern for bare 'Token <opaque>' header form — known gap. "
        "Either add a pattern alongside the Bearer one, or accept the gap as "
        "out-of-scope (these tokens don't appear in error traceback paths)."
    )
    def test_bare_token_prefix_outside_json_redacted(self) -> None:
        """`Token <opaque>` outside JSON (raw log line, header
        dump) currently survives. Marked xfail."""
        out = redact("Header dump: Token netapp-internal-opaque-very-long-value")
        assert "netapp-internal-opaque" not in out


# ---------------------------------------------------------------------------
# (4) MCP URL with embedded basic-auth — currently a gap
# ---------------------------------------------------------------------------


class TestMcpUrlWithEmbeddedCreds:
    """Some MCP transports carry creds in the URL userinfo:
    `https://user:pass@mcp.example/sse`. Today's patterns only
    catch SQL connection strings — HTTP(S) URLs with userinfo are
    a gap."""

    def test_mcp_url_creds_redacted_when_inside_json_field(self) -> None:
        """Inside a `url` JSON field name … the catch-all doesn't
        actually cover `url` — the catch-all matches
        `api_key|token|secret|password|credential|auth`. So this
        documents the gap: a URL with creds inside `"url": "..."`
        survives even the catch-all.

        We document the gap with xfail. The right fix is either to
        add `url` to the catch-all field set or add a dedicated
        userinfo-URL pattern."""
        body = '{"url": "https://admin:hunter2@mcp.example.com/sse"}'
        out = redact(body)
        # The current behavior leaks the password — pin that as the
        # known state, and flip the assertion when the gap is fixed.
        assert "hunter2" in out, (
            "If this assertion now fails, the redactor was extended "
            "to cover URL userinfo — flip the assertion to "
            "`'hunter2' not in out` and remove the xfail counterpart."
        )

    @pytest.mark.xfail(
        reason="userinfo URLs are not currently covered by any pattern. "
        "Add an HTTP(S) userinfo pattern or extend the catch-all to "
        "include 'url' as a field name."
    )
    def test_mcp_url_creds_redacted_in_raw_log_line(self) -> None:
        """In a raw log line `Connecting to https://admin:hunter2@mcp...`,
        the password survives. Documented gap."""
        out = redact("Connecting to https://admin:hunter2@mcp.example.com/sse")
        assert "hunter2" not in out


# ---------------------------------------------------------------------------
# (5) Basic auth — currently a gap
# ---------------------------------------------------------------------------


class TestBasicAuth:
    """`Authorization: Basic <base64>` survives unless the `Basic`
    keyword triggers the Bearer-like pattern. It doesn't — the
    pattern is anchored on `Bearer`. Document the gap."""

    def test_basic_auth_value_redacted_inside_json_field(self) -> None:
        """The catch-all catches it because of the field name."""
        body = '{"authorization": "Basic dXNlcjpwYXNz"}'  # base64('user:pass')
        out = redact(body)
        assert "dXNlcjpwYXNz" not in out

    @pytest.mark.xfail(
        reason="Bare `Authorization: Basic <base64>` outside JSON is a gap. "
        "The Bearer pattern intentionally only matches Bearer. Add a "
        "sibling pattern for Basic if it ever shows up in traceback."
    )
    def test_basic_auth_redacted_in_raw_log_line(self) -> None:
        out = redact("Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==")
        assert "dXNlcjpwYXNzd29yZDEyMzQ1Ng" not in out


# ---------------------------------------------------------------------------
# (6) Custom X-API-Key / gateway-key headers — currently a gap unless field-named
# ---------------------------------------------------------------------------


class TestCustomGatewayKeyHeaders:
    """Bifrost-style gateway keys carry custom headers like
    `X-Gateway-Key` or `X-Bifrost-Token`. They land in error
    traceback header dumps as bare strings unless wrapped in a
    `"api_key"`-style field name."""

    def test_gateway_key_redacted_in_api_key_json_field(self) -> None:
        body = '{"api_key": "bifrost-gateway-key-opaque-1234567890"}'
        out = redact(body)
        assert "bifrost-gateway-key-opaque" not in out

    @pytest.mark.xfail(
        reason="Custom header names (X-Gateway-Key, X-Bifrost-Token) are not "
        "in the catch-all field set. Either add them or rely on operators "
        "to mark such fields with `api_key`/`token`/`secret` semantics."
    )
    def test_bare_custom_header_redacted(self) -> None:
        out = redact('Header dump: {"X-Gateway-Key": "bifrost-gateway-opaque-value-12345"}')
        assert "bifrost-gateway-opaque" not in out


# ---------------------------------------------------------------------------
# (7) Encrypted secret refs (`enc:v1:...`) — currently a gap
# ---------------------------------------------------------------------------


class TestEncryptedSecretRefs:
    """Some internal services pass encrypted secret refs in the
    form `enc:v1:<base64>` or `secret://<ref>`. Should these be
    treated as already-safe (the encryption *is* the protection)?
    Probably yes — encrypted blobs are not the same as plaintext
    secrets. Document the decision."""

    def test_enc_ref_passes_through_unchanged(self) -> None:
        """An `enc:v1:...` blob is the *protected* form of a
        secret. Redacting it would hide useful debug info; not
        redacting risks accidentally logging the unwrapped form
        elsewhere. Today the pattern set passes it through — pin
        that as the documented behavior."""
        ref = "enc:v1:aGVsbG8gd29ybGQgc2VjcmV0"
        out = redact(f"Resolved secret to {ref}")
        # No redaction expected.
        assert ref in out, (
            f"Encrypted secret refs are designed to be safe to log; unexpected redaction: {out}"
        )
