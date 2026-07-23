"""Unit tests for the output sanitizer guardrail (Task 003 #3)."""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.output_sanitizer import OutputSanitizer


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


class TestOutputSanitizer:
    def test_name(self) -> None:
        assert OutputSanitizer().name == "output_sanitizer"

    def test_default_action_is_warn(self) -> None:
        assert OutputSanitizer()._trigger_action == GuardrailAction.WARN  # type: ignore[attr-defined]

    async def test_clean_text_allows(self) -> None:
        result = await OutputSanitizer().check(_ctx("Just a normal answer."))
        assert result.action == GuardrailAction.ALLOW

    async def test_html_detected_warn_default(self) -> None:
        result = await OutputSanitizer().check(_ctx("Here: <script>x()</script>"))
        assert result.action == GuardrailAction.WARN

    async def test_javascript_url_detected(self) -> None:
        result = await OutputSanitizer().check(_ctx("Click javascript:alert(1) now"))
        assert result.action == GuardrailAction.WARN

    async def test_ssrf_localhost_detected(self) -> None:
        result = await OutputSanitizer().check(_ctx("See http://127.0.0.1/admin"))
        assert result.action == GuardrailAction.WARN

    async def test_cloud_metadata_detected(self) -> None:
        result = await OutputSanitizer().check(_ctx("Fetch http://169.254.169.254/latest"))
        assert result.action == GuardrailAction.WARN

    async def test_safe_https_url_allowed(self) -> None:
        result = await OutputSanitizer().check(_ctx("Visit https://example.com/page"))
        assert result.action == GuardrailAction.ALLOW

    async def test_modify_escapes_html(self) -> None:
        guard = OutputSanitizer(config={"action_on_trigger": "modify"})
        result = await guard.check(_ctx("<b>hi</b>"))
        assert result.action == GuardrailAction.MODIFY
        assert "<b>" not in (result.modified_content or "")
        assert "&lt;b&gt;" in (result.modified_content or "")

    async def test_modify_strips_unsafe_url(self) -> None:
        guard = OutputSanitizer(config={"action_on_trigger": "modify", "sanitize_html": False})
        result = await guard.check(_ctx("go javascript:alert(1) end"))
        assert result.action == GuardrailAction.MODIFY
        assert "javascript:alert(1)" not in (result.modified_content or "")
        assert "[URL_REMOVED]" in (result.modified_content or "")

    async def test_block_action(self) -> None:
        guard = OutputSanitizer(config={"action_on_trigger": "block"})
        result = await guard.check(_ctx("<iframe src=evil></iframe>"))
        assert result.action == GuardrailAction.BLOCK

    async def test_block_private_ips_off_allows(self) -> None:
        guard = OutputSanitizer(config={"block_private_ips": False, "sanitize_html": False})
        result = await guard.check(_ctx("http://127.0.0.1/x"))
        assert result.action == GuardrailAction.ALLOW

    async def test_sanitize_html_off_ignores_html(self) -> None:
        guard = OutputSanitizer(config={"sanitize_html": False, "check_urls": False})
        result = await guard.check(_ctx("<script>x</script>"))
        assert result.action == GuardrailAction.ALLOW
