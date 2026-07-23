"""Query parameter builders for ONTAP log/event REST endpoints (EMS, audit)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple, Union

QueryParamPairs = List[Tuple[str, str]]
OntapQueryParams = Union[Dict[str, Any], QueryParamPairs]

# Agents may request up to one year of live-buffer history per call.
LOG_MAX_HOURS = 8760

_TIME_FIELD_KEY = "__time_field__"
_TIME_AFTER_KEY = "__time_after__"
_TIME_BEFORE_KEY = "__time_before__"

LOG_MAX_RECORDS_DEFAULT = 50
LOG_MAX_RECORDS_HARD = 200

DEFAULT_EMS_EVENT_FIELDS = (
    "time,node.name,node.uuid,index,message.name,message.severity,log_message,source"
)

DEFAULT_AUDIT_MESSAGE_FIELDS = (
    "timestamp,node.name,index,application,location,user,input,state,scope,role"
)

DEFAULT_EMS_CATALOG_FIELDS = "name,severity,description,corrective_action"


def cap_max_records(max_records: Optional[int]) -> int:
    if max_records is None:
        return LOG_MAX_RECORDS_DEFAULT
    try:
        value = int(max_records)
    except (TypeError, ValueError):
        return LOG_MAX_RECORDS_DEFAULT
    if value < 1:
        return 1
    return min(value, LOG_MAX_RECORDS_HARD)


def _strip_optional(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def format_ontap_time(dt: datetime) -> str:
    """Format a datetime for ONTAP REST time/timestamp query filters (UTC ISO-8601)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso_timestamp(value: str) -> datetime:
    """Parse an ISO-8601 timestamp from tool input."""
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def resolve_log_time_window(
    *,
    hours: Optional[float] = None,
    time_after: Optional[str] = None,
    time_before: Optional[str] = None,
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Resolve a log query window to ONTAP REST filter bounds.

    Returns ``(time_after_iso, time_before_iso, error_message)``.
    Explicit ``time_after`` / ``time_before`` override ``hours`` for the bound
    they set. ``hours`` sets ``time_after`` to now − hours when ``time_after``
    is omitted.
    """
    after_iso: Optional[str] = None
    before_iso: Optional[str] = None

    explicit_after = _strip_optional(time_after)
    explicit_before = _strip_optional(time_before)

    if explicit_after:
        try:
            after_iso = format_ontap_time(parse_iso_timestamp(explicit_after))
        except ValueError:
            return None, None, f"Invalid time_after: {time_after!r} (expected ISO-8601)"

    if explicit_before:
        try:
            before_iso = format_ontap_time(parse_iso_timestamp(explicit_before))
        except ValueError:
            return None, None, f"Invalid time_before: {time_before!r} (expected ISO-8601)"

    if after_iso is None and hours is not None:
        try:
            window_hours = float(hours)
        except (TypeError, ValueError):
            return None, None, f"Invalid hours: {hours!r}"
        if window_hours <= 0:
            return None, None, "hours must be greater than zero"
        if window_hours > LOG_MAX_HOURS:
            return None, None, f"hours must be at most {LOG_MAX_HOURS}"
        after_iso = format_ontap_time(datetime.now(timezone.utc) - timedelta(hours=window_hours))

    if after_iso and before_iso:
        if parse_iso_timestamp(after_iso) > parse_iso_timestamp(before_iso):
            return None, None, "time_after must be earlier than time_before"

    return after_iso, before_iso, None


def _attach_time_window(
    params: Dict[str, Any],
    *,
    time_field: str,
    hours: Optional[float] = None,
    time_after: Optional[str] = None,
    time_before: Optional[str] = None,
) -> Tuple[Dict[str, Any], Optional[str]]:
    after_iso, before_iso, err = resolve_log_time_window(
        hours=hours,
        time_after=time_after,
        time_before=time_before,
    )
    if err:
        return params, err
    if after_iso or before_iso:
        params[_TIME_FIELD_KEY] = time_field
        if after_iso:
            params[_TIME_AFTER_KEY] = after_iso
        if before_iso:
            params[_TIME_BEFORE_KEY] = before_iso
    return params, None


def flatten_log_query_params(params: Dict[str, Any]) -> QueryParamPairs:
    """Expand builder output into ONTAP REST query pairs (supports duplicate keys)."""
    pairs: QueryParamPairs = []
    time_field = params.get(_TIME_FIELD_KEY)
    time_after = params.get(_TIME_AFTER_KEY)
    time_before = params.get(_TIME_BEFORE_KEY)

    for key, value in params.items():
        if key.startswith("__"):
            continue
        pairs.append((key, str(value)))

    if time_field and time_after:
        pairs.append((time_field, f">{time_after}"))
    if time_field and time_before:
        pairs.append((time_field, f"<{time_before}"))

    return pairs


def log_time_window_metadata(
    params: Dict[str, Any],
    *,
    hours: Optional[float] = None,
    time_after: Optional[str] = None,
    time_before: Optional[str] = None,
) -> Dict[str, Any]:
    """Echo the resolved window in tool responses for agent traceability."""
    meta: Dict[str, Any] = {}
    if hours is not None:
        meta["hours"] = hours
    if _strip_optional(time_after):
        meta["time_after"] = time_after.strip()
    if _strip_optional(time_before):
        meta["time_before"] = time_before.strip()
    if params.get(_TIME_AFTER_KEY):
        meta["resolved_time_after"] = params[_TIME_AFTER_KEY]
    if params.get(_TIME_BEFORE_KEY):
        meta["resolved_time_before"] = params[_TIME_BEFORE_KEY]
    return meta


def build_ems_events_params(
    *,
    log_message: Optional[str] = None,
    message_severity: Optional[str] = None,
    message_name: Optional[str] = None,
    node_name: Optional[str] = None,
    filter_name: Optional[str] = None,
    max_records: Optional[int] = None,
    fields: Optional[str] = None,
    return_timeout: Optional[int] = None,
    hours: Optional[float] = None,
    time_after: Optional[str] = None,
    time_before: Optional[str] = None,
) -> Tuple[Dict[str, Any], Optional[str]]:
    params: Dict[str, Any] = {
        "fields": _strip_optional(fields) or DEFAULT_EMS_EVENT_FIELDS,
        "max_records": cap_max_records(max_records),
    }
    if _strip_optional(log_message):
        params["log_message"] = log_message.strip()
    if _strip_optional(message_severity):
        params["message.severity"] = message_severity.strip()
    if _strip_optional(message_name):
        params["message.name"] = message_name.strip()
    if _strip_optional(node_name):
        params["node.name"] = node_name.strip()
    if _strip_optional(filter_name):
        params["filter.name"] = filter_name.strip()
    if return_timeout is not None:
        try:
            timeout = int(return_timeout)
        except (TypeError, ValueError):
            timeout = 15
        params["return_timeout"] = max(0, min(timeout, 120))
    return _attach_time_window(
        params,
        time_field="time",
        hours=hours,
        time_after=time_after,
        time_before=time_before,
    )


def build_audit_messages_params(
    *,
    max_records: Optional[int] = None,
    fields: Optional[str] = None,
    return_timeout: Optional[int] = None,
    hours: Optional[float] = None,
    time_after: Optional[str] = None,
    time_before: Optional[str] = None,
) -> Tuple[Dict[str, Any], Optional[str]]:
    params: Dict[str, Any] = {
        "fields": _strip_optional(fields) or DEFAULT_AUDIT_MESSAGE_FIELDS,
        "max_records": cap_max_records(max_records),
    }
    if return_timeout is not None:
        try:
            timeout = int(return_timeout)
        except (TypeError, ValueError):
            timeout = 15
        params["return_timeout"] = max(0, min(timeout, 120))
    return _attach_time_window(
        params,
        time_field="timestamp",
        hours=hours,
        time_after=time_after,
        time_before=time_before,
    )


def build_ems_messages_params(
    *,
    name: Optional[str] = None,
    name_pattern: Optional[str] = None,
    max_records: Optional[int] = None,
    fields: Optional[str] = None,
) -> Dict[str, Any]:
    params: Dict[str, Any] = {
        "fields": _strip_optional(fields) or DEFAULT_EMS_CATALOG_FIELDS,
        "max_records": cap_max_records(max_records),
    }
    if _strip_optional(name):
        params["name"] = name.strip()
    elif _strip_optional(name_pattern):
        params["name"] = name_pattern.strip()
    return params
