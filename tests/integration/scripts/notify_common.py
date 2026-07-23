#!/usr/bin/env python3
"""Channel-agnostic notification model for integration-test failure alerts.

This module gathers everything a notification needs — severity, run metadata,
the parsed JUnit results (totals + failed tests), report links and the mention
target — into a single `NotificationContext`, independent of *how* it will be
delivered.

Each delivery channel is a thin renderer/sender on top of this:

    from notify_common import build_context
    ctx = build_context()
    # teams_notify.py  -> render Adaptive Card + POST to a Teams webhook
    # email_notify.py  -> render HTML + send via Graph/SMTP   (future)
    # slack_notify.py  -> render Block Kit + POST             (future)

Adding a channel therefore means adding one small module — no changes here and
no changes to the workflow's data plumbing. All fields are populated from the
shared `NOTIFY_*` / `ALLURE_*` environment variables so one workflow step can
drive any number of channels:

    NOTIFY_STATUS               run outcome: success | failure       (default: failure)
    NOTIFY_SEVERITY             gate | advisory | nightly           (default: gate)
    NOTIFY_GITHUB_LOGIN         PR-author login (display label only)  (optional)
    NOTIFY_EMAIL                PR-author email = Teams UPN; used as the mention
                                id so the person is actually pinged. A GitHub
                                `noreply` address is ignored (falls back to a
                                non-pinging author line).                (optional)
    NOTIFY_ENVIRONMENT          target environment label
    NOTIFY_ALLURE_PROJECT       Allure project id
    NOTIFY_IMAGE_TAG            image tag under test
    NOTIFY_RUN_URL              link back to the CI run
    NOTIFY_WORKFLOW_NAME        workflow display name
    NOTIFY_RUN_NUMBER           run number
    NOTIFY_EVENT_NAME           triggering event (push, schedule, ...)
    NOTIFY_REF_NAME             branch/ref name
    NOTIFY_COMMIT_SHA           commit SHA (truncated for display)
    NOTIFY_JUNIT_PATH           JUnit XML path (default: reports/junit.xml)
    NOTIFY_ARTIFACT_NAME        uploaded reports-artifact name
    NOTIFY_MAX_FAILED_LISTED    max failed tests to list (default: 10)
    ALLURE_ENDPOINT             Allure base URL (enables the report link)
"""

from __future__ import annotations

import os
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

# Semantic severity -> (human title, level) on FAILURE. Renderers map `level` to
# their own presentation (Teams: attention/warning colours; email: CSS; Slack:
# emoji).
SEVERITY: dict[str, tuple[str, str]] = {
    "gate": ("Integration tests FAILED \u2014 blocking gate", "critical"),
    "advisory": ("Integration tests FAILED \u2014 advisory (release not blocked)", "warning"),
    "nightly": ("Nightly integration tests FAILED", "critical"),
}

# Title used on SUCCESS (only reached by always-notify callers, e.g. nightly).
# Level "good" is a neutral/positive presentation for all channels.
SEVERITY_PASSED: dict[str, tuple[str, str]] = {
    "gate": ("Integration tests passed", "good"),
    "advisory": ("Integration tests passed", "good"),
    "nightly": ("Nightly integration tests PASSED", "good"),
}


def title_for(severity_key: str, succeeded: bool) -> tuple[str, str]:
    """Return the (title, level) for a severity given the run outcome."""
    table = SEVERITY_PASSED if succeeded else SEVERITY
    return table.get(severity_key, table["gate"])


@dataclass
class TestTotals:
    tests: int = 0
    passed: int = 0
    failures: int = 0
    errors: int = 0
    skipped: int = 0
    time: float = 0.0

    @property
    def failed(self) -> int:
        return self.failures + self.errors


@dataclass
class FailedTest:
    id: str
    kind: str  # "failure" | "error"
    message: str


@dataclass
class SuiteResult:
    """Per-suite (test module) roll-up of case outcomes."""

    name: str
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0

    @property
    def status(self) -> str:
        """PASS (no failures) | FAIL (nothing passed) | PARTIAL (mixed) | SKIP."""
        if self.failed == 0:
            return "SKIP" if self.passed == 0 else "PASS"
        return "FAIL" if self.passed == 0 else "PARTIAL"


@dataclass
class NotificationContext:
    """Everything any channel needs to render + address a failure alert."""

    severity_key: str
    succeeded: bool
    title: str
    level: str
    environment: str
    allure_project: str
    image_tag: str
    workflow: str
    run_number: str
    event_name: str
    ref_name: str
    commit_sha: str
    run_url: str
    allure_url: str
    artifact_name: str
    mention_login: str
    mention_email: str
    totals: TestTotals | None
    failed: list[FailedTest] = field(default_factory=list)
    suites: list[SuiteResult] = field(default_factory=list)
    max_failed: int = 10

    @property
    def short_sha(self) -> str:
        return (self.commit_sha or "")[:8]

    @property
    def artifact_url(self) -> str:
        return f"{self.run_url}#artifacts" if self.artifact_name and self.run_url else ""

    def status_message(self) -> str:
        """Compact one-liner, e.g. '3 failed | 2 passed | 1 skipped'."""
        if not self.totals:
            return ""
        parts = [f"{self.totals.failed} failed", f"{self.totals.passed} passed"]
        if self.totals.skipped:
            parts.append(f"{self.totals.skipped} skipped")
        return " | ".join(parts)

    def results_summary(self) -> str:
        """Verbose totals, e.g. '6 total · 2 passed · 3 failed · 1 skipped'."""
        if not self.totals:
            return ""
        t = self.totals
        return f"{t.tests} total \u00b7 {t.passed} passed \u00b7 {t.failed} failed \u00b7 {t.skipped} skipped"

    def badge_url(self) -> str:
        """shields.io status badge URL (empty when there are no parsed totals)."""
        if not self.totals:
            return ""
        color = "red" if self.totals.failed else "brightgreen"
        label = urllib.parse.quote("integration tests")
        return f"https://img.shields.io/badge/{label}-{urllib.parse.quote(self.status_message())}-{color}"

    def top_failed(self) -> tuple[list[FailedTest], int]:
        """The first `max_failed` failures plus the count omitted."""
        listed = self.failed[: self.max_failed]
        return listed, max(len(self.failed) - len(listed), 0)

    def pass_rate(self) -> int:
        """Passed / total as a rounded percentage (0 when there are no tests)."""
        if not self.totals or self.totals.tests <= 0:
            return 0
        return round(self.totals.passed / self.totals.tests * 100)

    def suite_rows(self) -> list[list[str]]:
        """Rows for the per-suite results table (failing suites first, then name)."""
        order = {"FAIL": 0, "PARTIAL": 1, "SKIP": 2, "PASS": 3}
        rows: list[list[str]] = []
        for s in sorted(self.suites, key=lambda s: (order.get(s.status, 9), s.name)):
            rows.append(
                [s.name, str(s.total), str(s.passed), str(s.failed), str(s.skipped), s.status]
            )
        return rows

    def overall_rows(self) -> list[list[str]]:
        """Rows for the overall-statistics table (empty when there are no totals)."""
        if not self.totals:
            return []
        t = self.totals
        return [
            ["Total Tests", str(t.tests)],
            ["Passed", str(t.passed)],
            ["Failed", str(t.failed)],
            ["Skipped", str(t.skipped)],
            ["Pass Rate", f"{self.pass_rate()}%"],
        ]


def _suite_name(classname: str) -> str:
    """Derive the test-module suite name from a JUnit testcase classname.

    pytest classnames are the dotted module path, optionally with a test class
    appended (e.g. ``suites.data_management.test_datasource_volume`` or
    ``suites.foo.test_bar.TestBaz``). We use the last dotted segment that starts
    with ``test`` (the module, e.g. ``test_datasource_volume``), so class-based
    tests still roll up under their module. Falls back to the last segment.
    """
    if not classname:
        return "unknown"
    segments = classname.split(".")
    for seg in reversed(segments):
        if seg.startswith("test"):
            return seg
    return segments[-1]


def parse_junit(path: str) -> tuple[TestTotals, list[FailedTest], list[SuiteResult]] | None:
    """Aggregate totals, failed cases and per-suite roll-ups from a JUnit XML file.

    Returns None when the file is missing or unparseable (e.g. an infra failure
    before pytest ran) so callers simply omit the results sections.
    """
    if not path or not os.path.isfile(path):
        return None
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return None

    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    totals = TestTotals()
    for s in suites:
        totals.tests += int(float(s.get("tests", 0) or 0))
        totals.failures += int(float(s.get("failures", 0) or 0))
        totals.errors += int(float(s.get("errors", 0) or 0))
        totals.skipped += int(float(s.get("skipped", 0) or 0))
        totals.time += float(s.get("time", 0) or 0)
    totals.passed = max(totals.tests - totals.failures - totals.errors - totals.skipped, 0)

    failed: list[FailedTest] = []
    by_suite: dict[str, SuiteResult] = {}
    for case in root.iter("testcase"):
        classname = case.get("classname", "")
        suite_name = _suite_name(classname)
        suite = by_suite.setdefault(suite_name, SuiteResult(name=suite_name))
        suite.total += 1

        problem = case.find("failure")
        kind = "failure"
        if problem is None:
            problem = case.find("error")
            kind = "error"

        if problem is not None:
            suite.failed += 1
            name = case.get("name", "")
            nodeid = f"{classname}::{name}" if classname else name
            raw = (problem.get("message") or problem.text or "").strip().splitlines()
            failed.append(FailedTest(id=nodeid, kind=kind, message=(raw[0][:200] if raw else "")))
        elif case.find("skipped") is not None:
            suite.skipped += 1
        else:
            suite.passed += 1

    return totals, failed, list(by_suite.values())


def _char_width(ch: str) -> int:
    """Approximate the monospace display width of a single character (0/1/2).

    Combining marks and the emoji variation selector take no width; East Asian
    "wide"/"full" characters and the misc-symbol / emoji ranges (e.g. the status
    glyphs ✅ ❌ ⚠️) render as two cells in most monospace fonts.
    """
    if ch == "\ufe0f" or unicodedata.combining(ch):
        return 0
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    o = ord(ch)
    if 0x2600 <= o <= 0x27BF or 0x1F000 <= o <= 0x1FAFF:
        return 2
    return 1


def _text_width(s: str) -> int:
    return sum(_char_width(c) for c in s)


# Non-breaking space: Adaptive Card / HTML renderers collapse runs of normal
# spaces (even in a Monospace TextBlock), which destroys column alignment. NBSP
# is not treated as collapsible whitespace, so padding survives.
_NBSP = "\u00a0"


def column_widths(headers: list[str], rows: list[list[str]], show_header: bool = True) -> list[int]:
    """Max display width per column across the header (optional) and all rows."""
    widths = [_text_width(headers[i]) if show_header else 0 for i in range(len(headers))]
    for row in rows:
        for i in range(len(row)):
            widths[i] = max(widths[i], _text_width(row[i]))
    return widths


def pad_cell(text: str, width: int, align: str = "l") -> str:
    """Pad ``text`` to ``width`` display cells with non-breaking spaces.

    NBSP is used because Adaptive Card / HTML renderers collapse runs of ordinary
    spaces, which would destroy column alignment; in a plain-text channel (email
    ``<pre>``, terminal) NBSP renders as an ordinary space.
    """
    fill = _NBSP * max(width - _text_width(text), 0)
    return (fill + text) if align == "r" else (text + fill)


def format_row(cells: list[str], widths: list[int], aligns: list[str], sep: str = " | ") -> str:
    """Join padded cells into one aligned row string (no outer border)."""
    return sep.join(pad_cell(cells[i], widths[i], aligns[i]) for i in range(len(cells)))


def format_ascii_table(
    headers: list[str],
    rows: list[list[str]],
    aligns: list[str] | None = None,
    show_header: bool = True,
) -> str:
    """Render a box-drawing table (channel-agnostic; used by plain-text channels).

    ``aligns`` is a per-column list of ``"l"`` (left, default) or ``"r"`` (right).
    Set ``show_header=False`` for label/value tables that omit the header row.
    Emoji-aware widths keep status glyphs lined up. Intended for size-unbounded
    channels (email ``<pre>``, terminal); Teams uses a leaner monospace layout to
    stay under the Adaptive Card size limit.
    """
    cols = len(headers)
    aligns = aligns or ["l"] * cols
    widths = column_widths(headers, rows, show_header)

    def cell(text: str, i: int) -> str:
        return pad_cell(text, widths[i], aligns[i])

    def line(row: list[str]) -> str:
        inner = (_NBSP + "\u2502" + _NBSP).join(cell(row[i], i) for i in range(cols))
        return "\u2502" + _NBSP + inner + _NBSP + "\u2502"

    def border(left: str, mid: str, right: str) -> str:
        return left + mid.join("─" * (w + 2) for w in widths) + right

    out = [border("┌", "┬", "┐")]
    if show_header:
        out.append(line(headers))
        out.append(border("├", "┼", "┤"))
    out.extend(line(row) for row in rows)
    out.append(border("└", "┴", "┘"))
    return "\n".join(out)


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _valid_mention_email(email: str) -> str:
    """Return a usable Teams mention id, or '' when it can't ping anyone.

    A mention only resolves when `mentioned.id` is the person's real email/UPN.
    GitHub `noreply` commit emails (e.g. `12345+login@users.noreply.github.com`)
    are not mailboxes/UPNs, so they are rejected — the renderer then names the
    author in plain text instead of a (broken) @-mention.
    """
    email = email.strip()
    if not email or "@" not in email:
        return ""
    if email.lower().endswith("users.noreply.github.com"):
        return ""
    return email


def build_context() -> NotificationContext:
    """Assemble a NotificationContext from the shared NOTIFY_* / ALLURE_* env."""
    severity_key = _env("NOTIFY_SEVERITY", "gate").lower()
    succeeded = _env("NOTIFY_STATUS", "failure").lower() == "success"
    title, level = title_for(severity_key, succeeded)

    login = _env("NOTIFY_GITHUB_LOGIN")
    mention_email = _valid_mention_email(_env("NOTIFY_EMAIL"))

    allure_endpoint = _env("ALLURE_ENDPOINT").rstrip("/")
    allure_project = _env("NOTIFY_ALLURE_PROJECT")
    allure_url = (
        f"{allure_endpoint}/allure-docker-service-ui/projects/{allure_project}"
        if allure_endpoint and allure_project
        else ""
    )

    parsed = parse_junit(_env("NOTIFY_JUNIT_PATH", "reports/junit.xml"))
    totals, failed, suites = parsed if parsed else (None, [], [])

    try:
        max_failed = int(_env("NOTIFY_MAX_FAILED_LISTED", "10"))
    except ValueError:
        max_failed = 10

    return NotificationContext(
        severity_key=severity_key,
        succeeded=succeeded,
        title=title,
        level=level,
        environment=_env("NOTIFY_ENVIRONMENT"),
        allure_project=allure_project,
        image_tag=_env("NOTIFY_IMAGE_TAG") or "n/a",
        workflow=_env("NOTIFY_WORKFLOW_NAME"),
        run_number=_env("NOTIFY_RUN_NUMBER"),
        event_name=_env("NOTIFY_EVENT_NAME"),
        ref_name=_env("NOTIFY_REF_NAME"),
        commit_sha=_env("NOTIFY_COMMIT_SHA"),
        run_url=_env("NOTIFY_RUN_URL"),
        allure_url=allure_url,
        artifact_name=_env("NOTIFY_ARTIFACT_NAME"),
        mention_login=login,
        mention_email=mention_email,
        totals=totals,
        failed=failed,
        suites=suites,
        max_failed=max_failed,
    )
