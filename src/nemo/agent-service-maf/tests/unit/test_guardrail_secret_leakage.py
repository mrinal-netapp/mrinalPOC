"""Unit tests for the secret leakage guardrail (Task 004 #1).

``detect-secrets`` is an optional dependency, so the scan path is mocked: the
lazy loader and ``_scan_with_detect_secrets`` are monkeypatched. The stdlib
connection-string supplement, the settings builder, dedupe, and action handling
are exercised directly. One ``skipif`` test runs the real package when present.
"""

from __future__ import annotations

from importlib import util as importlib_util

import pytest

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog import secret_leakage as sl
from agent_service_maf.guardrails.catalog.secret_leakage import (
    SecretLeakageConfig,
    SecretLeakageGuard,
    SecretMatch,
    _build_detect_secrets_settings,
    _scan_connection_strings,
)

_DETECT_SECRETS_INSTALLED = importlib_util.find_spec("detect_secrets") is not None


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


@pytest.fixture()
def _no_detect_secrets_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralise the detect-secrets dependency for guard construction + scanning."""
    monkeypatch.setattr(sl, "_load_detect_secrets", lambda: None)
    monkeypatch.setattr(sl, "_scan_with_detect_secrets", lambda text, settings: [])


# ---------------------------------------------------------------------------
# Settings builder
# ---------------------------------------------------------------------------


class TestBuildSettings:
    def test_entropy_plugins_always_disabled(self) -> None:
        settings = _build_detect_secrets_settings(SecretLeakageConfig())
        names = {p["name"] for p in settings["plugins_used"]}
        assert "Base64HighEntropyString" not in names
        assert "HexHighEntropyString" not in names

    def test_all_categories_enabled_includes_core_plugins(self) -> None:
        settings = _build_detect_secrets_settings(SecretLeakageConfig())
        names = {p["name"] for p in settings["plugins_used"]}
        assert "AWSKeyDetector" in names
        assert "PrivateKeyDetector" in names
        assert "JwtTokenDetector" in names
        assert "KeywordDetector" in names

    def test_vendor_toggle_off_drops_vendor_plugins(self) -> None:
        settings = _build_detect_secrets_settings(SecretLeakageConfig(vendor_api_keys=False))
        names = {p["name"] for p in settings["plugins_used"]}
        assert "AWSKeyDetector" not in names
        assert "PrivateKeyDetector" in names

    def test_private_keys_toggle_off(self) -> None:
        settings = _build_detect_secrets_settings(SecretLeakageConfig(private_keys=False))
        names = {p["name"] for p in settings["plugins_used"]}
        assert "PrivateKeyDetector" not in names

    def test_jwt_toggle_off(self) -> None:
        settings = _build_detect_secrets_settings(SecretLeakageConfig(jwt=False))
        names = {p["name"] for p in settings["plugins_used"]}
        assert "JwtTokenDetector" not in names

    def test_secret_patterns_toggle_off(self) -> None:
        settings = _build_detect_secrets_settings(SecretLeakageConfig(secret_patterns=False))
        names = {p["name"] for p in settings["plugins_used"]}
        assert "KeywordDetector" not in names
        assert "BasicAuthDetector" not in names


# ---------------------------------------------------------------------------
# Connection-string supplement (stdlib)
# ---------------------------------------------------------------------------


class TestConnectionStrings:
    def test_postgres_uri_detected(self) -> None:
        matches = _scan_connection_strings("db at postgres://user:pass@host:5432/db end")
        assert len(matches) == 1
        assert matches[0].placeholder == "[CONNECTION_STRING_REDACTED]"

    def test_mongodb_srv_detected(self) -> None:
        matches = _scan_connection_strings("uri mongodb+srv://u:p@cluster/db here")
        assert len(matches) == 1

    def test_azure_sql_detected(self) -> None:
        text = "Server=tcp:mysrv.database.windows.net,1433;User=a;Password=secret123;"
        matches = _scan_connection_strings(text)
        assert len(matches) == 1

    def test_clean_text_no_matches(self) -> None:
        assert _scan_connection_strings("just some normal prose here") == []


# ---------------------------------------------------------------------------
# Lazy import / ConfigurationError
# ---------------------------------------------------------------------------


class TestLazyImport:
    def test_missing_dependency_raises_configuration_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _boom() -> None:
            raise ConfigurationError("detect-secrets missing")

        monkeypatch.setattr(sl, "_load_detect_secrets", _boom)
        with pytest.raises(ConfigurationError):
            SecretLeakageGuard()


# ---------------------------------------------------------------------------
# Guard behaviour (detect-secrets path mocked)
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("_no_detect_secrets_calls")
class TestSecretLeakageGuard:
    def test_name(self) -> None:
        assert SecretLeakageGuard().name == "secret_leakage"

    def test_default_action_is_modify(self) -> None:
        g = SecretLeakageGuard()
        assert g._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]

    async def test_clean_text_allows(self) -> None:
        g = SecretLeakageGuard()
        result = await g.check(_ctx("The weather is sunny today."))
        assert result.action == GuardrailAction.ALLOW

    async def test_connection_string_redacted(self) -> None:
        g = SecretLeakageGuard()
        result = await g.check(_ctx("Connect via postgres://user:pass@host/db now."))
        assert result.action == GuardrailAction.MODIFY
        content = result.modified_content or ""
        assert "postgres://user:pass@host/db" not in content
        assert "[CONNECTION_STRING_REDACTED]" in content

    async def test_connection_strings_toggle_off(self) -> None:
        g = SecretLeakageGuard(config={"connection_strings": False})
        result = await g.check(_ctx("Connect via postgres://user:pass@host/db now."))
        assert result.action == GuardrailAction.ALLOW

    async def test_mocked_detect_secrets_hit_redacted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        text = "key AKIAIOSFODNN7EXAMPLE here"
        start = text.index("AKIAIOSFODNN7EXAMPLE")
        end = start + len("AKIAIOSFODNN7EXAMPLE")
        monkeypatch.setattr(
            sl,
            "_scan_with_detect_secrets",
            lambda t, s: [SecretMatch("AWS Access Key", start, end, "[API_KEY_REDACTED]")],
        )
        g = SecretLeakageGuard()
        result = await g.check(_ctx(text))
        assert result.action == GuardrailAction.MODIFY
        assert "AKIAIOSFODNN7EXAMPLE" not in (result.modified_content or "")
        assert "[API_KEY_REDACTED]" in (result.modified_content or "")

    async def test_block_action(self) -> None:
        g = SecretLeakageGuard(config={"action_on_trigger": "block"})
        result = await g.check(_ctx("postgres://user:pass@host/db"))
        assert result.action == GuardrailAction.BLOCK
        assert result.modified_content is None

    async def test_warn_action(self) -> None:
        g = SecretLeakageGuard(config={"action_on_trigger": "warn"})
        result = await g.check(_ctx("postgres://user:pass@host/db"))
        assert result.action == GuardrailAction.WARN
        assert result.modified_content is None

    async def test_custom_message(self) -> None:
        g = SecretLeakageGuard(config={"action_on_trigger": "block", "message": "no secrets"})
        result = await g.check(_ctx("postgres://user:pass@host/db"))
        assert result.message == "no secrets"

    async def test_details_never_contain_raw_secret(self) -> None:
        g = SecretLeakageGuard()
        result = await g.check(_ctx("Connect via postgres://user:pass@host/db now."))
        assert result.details is not None
        assert "pass" not in str(result.details.get("match_types"))
        assert result.details["match_count"] == 1

    async def test_overlapping_spans_deduped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # detect-secrets reports a span that overlaps a connection-string supplement hit.
        text = "postgres://user:pass@host/db"
        monkeypatch.setattr(
            sl,
            "_scan_with_detect_secrets",
            lambda t, s: [SecretMatch("Secret Keyword", 0, 10, "[CREDENTIAL_REDACTED]")],
        )
        g = SecretLeakageGuard()
        result = await g.check(_ctx(text))
        assert result.action == GuardrailAction.MODIFY
        # Longest span (the full connection string) wins; only one redaction.
        assert (result.modified_content or "") == "[CONNECTION_STRING_REDACTED]"


# ---------------------------------------------------------------------------
# Real-package smoke test (only when detect-secrets is installed)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not _DETECT_SECRETS_INSTALLED, reason="detect-secrets not installed")
class TestRealDetectSecrets:
    async def test_aws_key_detected_with_real_package(self) -> None:
        g = SecretLeakageGuard()
        result = await g.check(_ctx("aws_access_key_id = AKIAIOSFODNN7EXAMPLE"))
        assert result.action == GuardrailAction.MODIFY
        assert "AKIAIOSFODNN7EXAMPLE" not in (result.modified_content or "")
