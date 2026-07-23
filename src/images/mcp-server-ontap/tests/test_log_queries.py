"""Unit tests for ONTAP log query parameter builders."""

from pathlib import Path
import sys
from datetime import datetime, timedelta, timezone

# Ensure tests can import sibling modules when pytest runs from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from log_queries import (
    LOG_MAX_HOURS,
    LOG_MAX_RECORDS_HARD,
    build_audit_messages_params,
    build_ems_events_params,
    build_ems_messages_params,
    cap_max_records,
    flatten_log_query_params,
    format_ontap_time,
    parse_iso_timestamp,
    resolve_log_time_window,
)


def test_cap_max_records_defaults():
    assert cap_max_records(None) == 50
    assert cap_max_records(10) == 10
    assert cap_max_records(9999) == LOG_MAX_RECORDS_HARD
    assert cap_max_records(0) == 1
    assert cap_max_records(-5) == 1


def test_build_ems_events_params_maps_tool_args_to_rest():
    params, err = build_ems_events_params(
        log_message="*disk*",
        message_severity="alert,error",
        message_name="wafl.*",
        node_name="node1",
        filter_name="critical-wafl",
        max_records=25,
    )
    assert err is None
    assert params["log_message"] == "*disk*"
    assert params["message.severity"] == "alert,error"
    assert params["message.name"] == "wafl.*"
    assert params["node.name"] == "node1"
    assert params["filter.name"] == "critical-wafl"
    assert params["max_records"] == 25
    assert "time" in params["fields"]


def test_build_ems_events_params_omits_empty_filters():
    params, err = build_ems_events_params(max_records=5)
    assert err is None
    assert "log_message" not in params
    assert "message.severity" not in params
    assert params["max_records"] == 5


def test_build_ems_events_params_hours_adds_time_filter():
    params, err = build_ems_events_params(hours=720, max_records=5)
    assert err is None
    pairs = flatten_log_query_params(params)
    time_pairs = [pair for pair in pairs if pair[0] == "time"]
    assert len(time_pairs) == 1
    assert time_pairs[0][1].startswith(">")


def test_build_audit_messages_params():
    params, err = build_audit_messages_params(max_records=100)
    assert err is None
    assert params["max_records"] == 100
    assert "timestamp" in params["fields"]


def test_build_audit_messages_params_explicit_time_range():
    params, err = build_audit_messages_params(
        time_after="2026-05-10T00:00:00Z",
        time_before="2026-06-09T00:00:00Z",
        max_records=10,
    )
    assert err is None
    pairs = flatten_log_query_params(params)
    assert ("timestamp", ">2026-05-10T00:00:00Z") in pairs
    assert ("timestamp", "<2026-06-09T00:00:00Z") in pairs


def test_resolve_log_time_window_rejects_inverted_range():
    _, _, err = resolve_log_time_window(
        time_after="2026-06-09T00:00:00Z",
        time_before="2026-05-10T00:00:00Z",
    )
    assert err is not None


def test_resolve_log_time_window_hours():
    after, before, err = resolve_log_time_window(hours=24)
    assert err is None
    assert after is not None
    assert before is None
    parsed = parse_iso_timestamp(after)
    assert parsed <= datetime.now(timezone.utc)
    assert parsed >= datetime.now(timezone.utc) - timedelta(hours=25)


def test_resolve_log_time_window_rejects_excessive_hours():
    _, _, err = resolve_log_time_window(hours=LOG_MAX_HOURS + 1)
    assert err is not None


def test_format_and_parse_iso_timestamp():
    dt = datetime(2026, 5, 10, 12, 30, 0, tzinfo=timezone.utc)
    iso = format_ontap_time(dt)
    assert iso == "2026-05-10T12:30:00Z"
    assert format_ontap_time(parse_iso_timestamp(iso)) == iso


def test_build_ems_messages_params_exact_name():
    params = build_ems_messages_params(name="raid.autoPart.disabled", max_records=1)
    assert params["name"] == "raid.autoPart.disabled"
    assert params["max_records"] == 1


def test_build_ems_messages_params_pattern():
    params = build_ems_messages_params(name_pattern="disk*")
    assert params["name"] == "disk*"
