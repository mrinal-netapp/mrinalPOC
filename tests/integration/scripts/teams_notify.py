#!/usr/bin/env python3
"""Deliver an integration-test result notification to a Microsoft Teams channel.

Handles both failure alerts and (for always-notify callers such as nightly)
pass notifications; the outcome is carried by the shared NotificationContext.

Thin Teams channel on top of the shared :mod:`notify_common` model: it renders a
`NotificationContext` as an Adaptive Card and POSTs it to a Teams *Workflows*
(Power Automate) inbound webhook ("Post to a channel when a webhook request is
received" template, which accepts the connector-style
`{type: message, attachments: [...]}` envelope).

Only Teams-specific concerns live here — Adaptive Card layout, the
`msteams.entities` @-mention, and webhook delivery. All data gathering (JUnit
parse, run metadata, links, mention target) lives in `notify_common` so future
channels (email, Slack, ...) reuse it unchanged.

When a PR-author login is provided (release pipeline on merge to main), the card
@-mentions that author so they are pinged and asked to take action.

Env:
    TEAMS_WEBHOOK_URL  Teams Workflows inbound webhook URL (required; skip if unset).
    Plus the shared NOTIFY_* / ALLURE_* vars consumed by notify_common.build_context().

Best-effort by design: a delivery failure prints a warning and exits 0 so the
notification step never masks or changes the (already failing) test result.
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request

from notify_common import (
    NotificationContext,
    build_context,
    column_widths,
    format_row,
)

# Semantic level -> Adaptive Card TextBlock colour.
_LEVEL_COLOR = {"critical": "attention", "warning": "warning", "good": "good"}

# Suite status -> Adaptive Card colour (green / yellow / red).
_STATUS_COLOR = {"PASS": "good", "PARTIAL": "warning", "SKIP": "warning", "FAIL": "attention"}

# GitHub Environment names for preprod OIDC (azure/gcp/aws) differ from the
# human-facing labels used in Allure and job titles; map only for Teams display.
_TEAMS_ENV_DISPLAY = {
    "azure": "preprod-aks",
    "gcp": "preprod-gke",
    "aws": "preprod-eks",
}


def _teams_environment_label(environment: str) -> str:
    return _TEAMS_ENV_DISPLAY.get(environment, environment)


def _mono(text: str, color: str | None = None, bold: bool = False, spacing: str = "None") -> dict:
    """A compact monospace TextBlock (one or more table lines)."""
    block: dict = {"type": "TextBlock", "text": text, "wrap": False, "fontType": "Monospace", "spacing": spacing}
    if color:
        block["color"] = color
    if bold:
        block["weight"] = "Bolder"
    return block


def _section_title(text: str) -> dict:
    return {"type": "TextBlock", "text": text, "weight": "Bolder", "size": "Medium", "spacing": "Medium", "wrap": True}


def _suite_blocks(suite_rows: list[list[str]]) -> list[dict]:
    """Monospace suite table whose rows are grouped and coloured by status.

    Rendered as text (not a native Table / ColumnSet) to stay well under the
    Adaptive Card ~28 KB limit: a full run of ~70 suites is a few KB this way,
    versus 30-60 KB as per-cell elements. ``suite_rows`` is pre-sorted by status,
    so each status forms one contiguous, single-coloured TextBlock. Colour is
    per row (whole row) rather than per cell — per-cell colouring needs one
    element per cell, which does not fit at this scale.
    """
    headers = ["Test Suite", "Total", "Passed", "Failed", "Skipped", "Status"]
    aligns = ["l", "r", "r", "r", "r", "l"]
    widths = column_widths(headers, suite_rows)

    # Header is its own block (not bold, no "----" underline): a text line
    # followed by a line of dashes is Markdown setext-heading syntax, which Teams
    # renders as a large H2 and misaligns the columns. A box-drawing rule (U+2500)
    # is not setext, so it is safe as a separator inside the same block.
    header_line = format_row(headers, widths, aligns)
    rule = "\u2500" * len(header_line)
    blocks = [_mono(header_line + "\n" + rule, spacing="Medium")]

    group: list[str] = []
    group_status = suite_rows[0][-1] if suite_rows else ""
    for row in suite_rows:
        if row[-1] != group_status:
            blocks.append(_mono("\n".join(group), color=_STATUS_COLOR.get(group_status)))
            group, group_status = [], row[-1]
        group.append(format_row(row, widths, aligns))
    if group:
        blocks.append(_mono("\n".join(group), color=_STATUS_COLOR.get(group_status)))
    return blocks


def _overall_blocks(overall_rows: list[list[str]]) -> list[dict]:
    """Compact monospace label/value table (no header, no colour)."""
    widths = column_widths(["", ""], overall_rows, show_header=False)
    lines = [format_row(row, widths, ["l", "r"]) for row in overall_rows]
    return [_mono("\n".join(lines))]


def render_card(ctx: NotificationContext) -> dict:
    """Render the notification context as a Teams message (Adaptive Card)."""
    facts = [
        {"title": "Environment:", "value": _teams_environment_label(ctx.environment)},
        {"title": "Workflow:", "value": f"{ctx.workflow} #{ctx.run_number}"},
        {"title": "Trigger:", "value": ctx.event_name},
    ]
    if ctx.severity_key != "nightly":
        facts.extend(
            [
                {"title": "Branch/ref:", "value": ctx.ref_name},
                {"title": "Commit:", "value": ctx.short_sha},
            ]
        )
    if ctx.totals:
        facts.append({"title": "Duration:", "value": f"{ctx.totals.time:.0f}s"})

    body: list[dict] = [
        {
            "type": "TextBlock",
            "text": ctx.title,
            "weight": "Bolder",
            "size": "Medium",
            "color": _LEVEL_COLOR.get(ctx.level, "attention"),
            "wrap": True,
        }
    ]

    # Status badge (Teams fetches the image server-side, so it renders
    # regardless of the self-hosted runner's egress).
    badge = ctx.badge_url()
    if badge:
        body.append(
            {"type": "Image", "url": badge, "altText": "integration test results", "size": "Large"}
        )

    body.append({"type": "FactSet", "facts": facts})

    # Per-suite results table (grouped by test module), coloured by status.
    suite_rows = ctx.suite_rows()
    if suite_rows:
        body.append(_section_title("\U0001f4c8 Test Suite Results"))
        body.extend(_suite_blocks(suite_rows))

    # Overall statistics table (label/value, no header row).
    overall_rows = ctx.overall_rows()
    if overall_rows:
        body.append(_section_title("\U0001f4ca Overall Statistics"))
        body.extend(_overall_blocks(overall_rows))

    # Failed-test list (names only, top N, truncated to stay under the ~28 KB card limit).
    listed, remaining = ctx.top_failed()
    if listed:
        lines = "\n".join(f"- **{f.id}**" for f in listed)
        if remaining:
            lines += f"\n\n\u2026and {remaining} more"
        body.append({"type": "TextBlock", "text": "Failed tests", "weight": "Bolder", "spacing": "Medium"})
        body.append({"type": "TextBlock", "text": lines, "wrap": True, "fontType": "Monospace", "size": "Small"})

    entities: list[dict] = []
    action_line = (
        "the integration tests passed."
        if ctx.succeeded
        else "please investigate and take action on the failing integration tests."
    )
    if ctx.mention_email:
        # Real @-mention: `mentioned.id` must be the person's email/UPN. The
        # <at> label + name are display-only.
        label = ctx.mention_login or ctx.mention_email
        body.append(
            {
                "type": "TextBlock",
                "text": f"<at>{label}</at> \u2014 {action_line}",
                "weight": "Bolder",
                "wrap": True,
            }
        )
        entities.append(
            {
                "type": "mention",
                "text": f"<at>{label}</at>",
                "mentioned": {"id": ctx.mention_email, "name": label},
            }
        )
    elif ctx.mention_login:
        # No resolvable email (e.g. GitHub noreply): name the author in plain
        # text so ownership is clear, but without a broken @-mention.
        body.append(
            {
                "type": "TextBlock",
                "text": f"PR author: {ctx.mention_login} \u2014 {action_line}",
                "weight": "Bolder",
                "wrap": True,
            }
        )

    actions: list[dict] = [{"type": "Action.OpenUrl", "title": "View workflow run", "url": ctx.run_url}]
    if ctx.allure_url:
        actions.append({"type": "Action.OpenUrl", "title": "View Allure report", "url": ctx.allure_url})
    if ctx.artifact_url:
        # The full HTML report can't ride in a Teams message; link to the run
        # page where the reports artifact is available for download.
        actions.append({"type": "Action.OpenUrl", "title": "Download report bundle", "url": ctx.artifact_url})

    card: dict = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body": body,
        "actions": actions,
    }
    # `width: Full` makes Teams render the card across the full message width so
    # the wide results table isn't truncated.
    msteams: dict = {"width": "Full"}
    if entities:
        msteams["entities"] = entities
    card["msteams"] = msteams

    return {
        "type": "message",
        "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}],
    }


def post(webhook: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as resp:
            print(f"Teams notification posted (HTTP {resp.status}).")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 - best-effort diagnostics only
            pass
        print(f"::warning::Teams notification failed (HTTP {exc.code}). {detail}")
    except Exception as exc:  # noqa: BLE001 - never fail the (already failed) job
        print(f"::warning::Teams notification failed: {exc}")


def main() -> int:
    webhook = (os.environ.get("TEAMS_WEBHOOK_URL") or "").strip()
    if not webhook:
        print("TEAMS_WEBHOOK_URL not set; skipping Teams notification.")
        return 0
    post(webhook, render_card(build_context()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
