"""NetApp ONTAP MCP server.

Exposes a stable set of read tools (always available) and a configurable set
of write tools (gated by ``ONTAP_ALLOWED_TOOLS`` so the operator can keep the
server read-only by default). Every write tool emits a structured audit JSON
line to stdout (or ``ONTAP_MCP_AUDIT_DEST`` when set) before the change is
applied — see ``_audit()`` below.

Environment contract (matches the catalog ``credentialMapping`` for
``Ontap_mcp_logs``):

  ONTAP_CLUSTER_URL          required
  ONTAP_USERNAME             basic auth (user)
  ONTAP_PASSWORD             basic auth (pass)
  ONTAP_CLIENT_CERT_PATH     mTLS client cert (PEM path; used only if file exists)
  ONTAP_CLIENT_KEY_PATH      mTLS client key  (PEM path; used only if file exists)
  ONTAP_CA_BUNDLE_PATH       optional CA bundle (PEM path; used only if file exists)
  ONTAP_VERIFY_TLS           "true"/"false" (default true)
  ONTAP_DEFAULT_SVM          optional default SVM name
  ONTAP_ALLOWED_TOOLS        comma-separated allowlist; empty = read-only set
  ONTAP_MCP_AUDIT_DEST       "stdout" (default) — future: file path / collector URL

Reuses the canonical ``ontap_common`` REST client so behavior matches the
connector-worker adapter.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP
from observability_client_runtime import configure_observability_minimal, get_logger

from log_queries import (
    build_audit_messages_params,
    build_ems_events_params,
    build_ems_messages_params,
    flatten_log_query_params,
    log_time_window_metadata,
)

from ontap_common import (
    OntapAuthError,
    OntapClient,
    OntapError,
    OntapHTTPError,
    OntapTLSVerifyError,
)

configure_observability_minimal(
    log_file_path=os.getenv(
        "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/mcp-server-ontap.jsonl"
    ),
    log_level=os.getenv("LOG_LEVEL", "info"),
    otlp_traces_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
    metrics_service_name=os.getenv("OTEL_SERVICE_NAME", "mcp-server-ontap"),
    prometheus_metrics_port=int(p) if (p := os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT")) else None,
)
logger = get_logger()

# ── Tool surface ───────────────────────────────────────────────────────────────

# READ tools are always exposed. WRITE tools must be explicitly allowed via
# ONTAP_ALLOWED_TOOLS to be registered. Names are stable per the design plan
# (see fix #12 in the design doc) — do not rename without bumping the catalog.
READ_TOOLS = {
    "list_svms",
    "list_volumes",
    "list_luns",
    "list_snapshots",
    "list_aggregates",
    "list_network_interfaces",
    "get_volume",
    "get_cluster",
    "get_volume_metrics",
    "query_ems_events",
    "get_ems_event",
    "lookup_ems_message",
    "query_audit_messages",
}

WRITE_TOOLS = {
    "create_snapshot",
    "delete_snapshot",
    "restore_snapshot",
    "create_volume",
    "delete_volume",
    "resize_volume",
    "set_volume_qos",
    "set_export_policy",
}

ALL_TOOLS = READ_TOOLS | WRITE_TOOLS

# Log once when cert/key env paths are set but files are absent (wrappers may inject paths).
_MTLS_PATH_FALLBACK_WARNED = False


def _allowed_tools() -> set[str]:
    raw = (os.environ.get("ONTAP_ALLOWED_TOOLS") or "").strip()
    if not raw:
        return set(READ_TOOLS)
    requested = {t.strip() for t in raw.split(",") if t.strip()}
    valid = requested & ALL_TOOLS
    rejected = requested - ALL_TOOLS
    if rejected:
        logger.warning("Ignoring unknown tool names: %s", sorted(rejected))
    return valid or set(READ_TOOLS)


# ── Audit logging ──────────────────────────────────────────────────────────────

_AUDIT_REDACT_KEYS = {"password", "token", "secret"}


def _redact(args: Dict[str, Any]) -> Dict[str, Any]:
    redacted: Dict[str, Any] = {}
    for k, v in args.items():
        if any(rk in k.lower() for rk in _AUDIT_REDACT_KEYS):
            redacted[k] = "***"
        else:
            redacted[k] = v
    return redacted


def _audit(tool: str, args: Dict[str, Any], status: str, error: Optional[str] = None) -> None:
    """Emit a structured audit log line for write tools.

    Default destination is stdout (with the ``audit=true`` marker so log
    pipelines can route it). Set ``ONTAP_MCP_AUDIT_DEST=stderr`` to redirect
    to stderr; future: file path / OTLP collector.
    """
    record = {
        "audit": True,
        "ts": int(time.time() * 1000),
        "tool": tool,
        "args": _redact(args),
        "status": status,
        "cluster_url": os.environ.get("ONTAP_CLUSTER_URL", ""),
    }
    if error:
        record["error"] = error
    line = json.dumps(record, separators=(",", ":"))
    dest = (os.environ.get("ONTAP_MCP_AUDIT_DEST") or "stdout").lower()
    if dest == "stderr":
        print(line, file=sys.stderr, flush=True)
    else:
        print(line, flush=True)


# ── Client construction ────────────────────────────────────────────────────────


def _bool_env(name: str, default: bool = True) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() not in ("false", "0", "no", "off")


def _build_credential() -> Dict[str, str]:
    """Translate the environment back into the credential dict shape that
    ontap_common.OntapClient expects. PEM file paths are read into memory; the
    client then re-writes them to per-call tempfiles with restricted perms.

    mTLS is used only when both cert and key paths are set **and** both files
    exist. If a wrapper sets ONTAP_CLIENT_* to default paths without mounting
    PEMs, we fall back to basic auth when username/password are present.
    """
    global _MTLS_PATH_FALLBACK_WARNED
    cred: Dict[str, str] = {}
    user = os.environ.get("ONTAP_USERNAME")
    pwd = os.environ.get("ONTAP_PASSWORD")
    if user and pwd:
        cred["username"] = user
        cred["password"] = pwd

    cert_path = (os.environ.get("ONTAP_CLIENT_CERT_PATH") or "").strip()
    key_path = (os.environ.get("ONTAP_CLIENT_KEY_PATH") or "").strip()
    cert_ok = bool(cert_path and os.path.isfile(cert_path))
    key_ok = bool(key_path and os.path.isfile(key_path))

    if cert_path and key_path:
        if cert_ok and key_ok:
            cred["client_cert_pem"] = _read_pem(cert_path, "client cert")
            cred["client_key_pem"] = _read_pem(key_path, "client key")
        elif cert_ok ^ key_ok:
            raise SystemExit(
                "ONTAP mTLS is incomplete: both PEM files must exist. "
                f"Missing {'client key' if cert_ok else 'client cert'} for paths "
                f"{cert_path!r} / {key_path!r}."
            )
        elif cred.get("username") and not _MTLS_PATH_FALLBACK_WARNED:
            logger.warning(
                "ONTAP_CLIENT_CERT_PATH / ONTAP_CLIENT_KEY_PATH are set but PEM files "
                "were not found; using basic auth."
            )
            _MTLS_PATH_FALLBACK_WARNED = True

    ca_path = (os.environ.get("ONTAP_CA_BUNDLE_PATH") or "").strip()
    if ca_path:
        if not os.path.isfile(ca_path):
            raise SystemExit(
                f"ONTAP_CA_BUNDLE_PATH is set but file is missing: {ca_path}"
            )
        cred["ca_bundle_pem"] = _read_pem(ca_path, "CA bundle")

    if "username" not in cred and "client_cert_pem" not in cred:
        raise SystemExit(
            "ONTAP MCP requires either basic auth (ONTAP_USERNAME + ONTAP_PASSWORD) "
            "or mTLS (PEM files present at ONTAP_CLIENT_CERT_PATH + ONTAP_CLIENT_KEY_PATH)."
        )
    return cred


def _read_pem(path: str, label: str) -> str:
    try:
        with open(path, "r") as f:
            return f.read()
    except OSError as e:
        raise SystemExit(f"Failed to read {label} from {path}: {e}")


def _ontap_client() -> OntapClient:
    cluster_url = (os.environ.get("ONTAP_CLUSTER_URL") or "").strip()
    if not cluster_url:
        raise SystemExit("ONTAP_CLUSTER_URL is required")
    return OntapClient(
        cluster_url=cluster_url,
        credential=_build_credential(),
        verify_tls=_bool_env("ONTAP_VERIFY_TLS", default=True),
    )


def _default_svm_or(svm: Optional[str]) -> Optional[str]:
    if svm and svm.strip():
        return svm.strip()
    fallback = os.environ.get("ONTAP_DEFAULT_SVM")
    return fallback.strip() if fallback and fallback.strip() else None


def _ontap_error(e: Exception) -> Dict[str, Any]:
    if isinstance(e, OntapTLSVerifyError):
        return {"error": {"code": "TLS_VERIFY_FAILED", "message": str(e), "hint": e.hint}}
    if isinstance(e, OntapAuthError):
        return {"error": {"code": "UNAUTHORIZED", "message": str(e)}}
    if isinstance(e, (OntapHTTPError, OntapError)):
        return {"error": {"code": "PROVIDER_ERROR", "message": str(e)}}
    return {"error": {"code": "PROVIDER_ERROR", "message": str(e)}}


def _strip_optional(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


# ── MCP server + tool registrations ───────────────────────────────────────────

mcp = FastMCP("ontap")
ALLOWED = _allowed_tools()


def _enabled(name: str) -> bool:
    return name in ALLOWED


# ── READ tools ────────────────────────────────────────────────────────────────

if _enabled("list_svms"):
    @mcp.tool()
    def list_svms() -> Dict[str, Any]:
        """List Storage VMs on the ONTAP cluster."""
        try:
            with _ontap_client() as client:
                page = client.get_paginated("/api/svm/svms", params={"fields": "uuid,name,state,ipspace,language"})
            return {"records": page.records, "truncated": page.truncated}
        except Exception as e:
            return _ontap_error(e)


if _enabled("list_volumes"):
    @mcp.tool()
    def list_volumes(svm_name: Optional[str] = None, svm_uuid: Optional[str] = None) -> Dict[str, Any]:
        """List volumes, optionally scoped by SVM (defaults to ONTAP_DEFAULT_SVM if set)."""
        try:
            params: Dict[str, Any] = {"fields": "uuid,name,state,size,space,type,style,svm,aggregates,nas"}
            if svm_uuid:
                params["svm.uuid"] = svm_uuid
            else:
                eff = _default_svm_or(svm_name)
                if eff:
                    params["svm.name"] = eff
            with _ontap_client() as client:
                page = client.get_paginated("/api/storage/volumes", params=params)
            return {"records": page.records, "truncated": page.truncated}
        except Exception as e:
            return _ontap_error(e)


if _enabled("list_luns"):
    @mcp.tool()
    def list_luns(svm_name: Optional[str] = None, svm_uuid: Optional[str] = None) -> Dict[str, Any]:
        """List LUNs, optionally scoped by SVM."""
        try:
            params: Dict[str, Any] = {"fields": "uuid,name,space,os_type,status,serial_number,svm"}
            if svm_uuid:
                params["svm.uuid"] = svm_uuid
            else:
                eff = _default_svm_or(svm_name)
                if eff:
                    params["svm.name"] = eff
            with _ontap_client() as client:
                page = client.get_paginated("/api/storage/luns", params=params)
            return {"records": page.records, "truncated": page.truncated}
        except Exception as e:
            return _ontap_error(e)


if _enabled("list_snapshots"):
    @mcp.tool()
    def list_snapshots(volume_uuid: str) -> Dict[str, Any]:
        """List snapshots for a given volume (volume_uuid is required)."""
        try:
            with _ontap_client() as client:
                page = client.get_paginated(
                    f"/api/storage/volumes/{volume_uuid}/snapshots",
                    params={"fields": "uuid,name,create_time,size,state"},
                )
            return {"records": page.records, "truncated": page.truncated}
        except Exception as e:
            return _ontap_error(e)


if _enabled("list_aggregates"):
    @mcp.tool()
    def list_aggregates() -> Dict[str, Any]:
        """List storage aggregates on the cluster."""
        try:
            with _ontap_client() as client:
                page = client.get_paginated(
                    "/api/storage/aggregates",
                    params={"fields": "uuid,name,space,block_storage,node,state"},
                )
            return {"records": page.records, "truncated": page.truncated}
        except Exception as e:
            return _ontap_error(e)


if _enabled("list_network_interfaces"):
    @mcp.tool()
    def list_network_interfaces() -> Dict[str, Any]:
        """List network IP interfaces (LIFs) on the cluster."""
        try:
            with _ontap_client() as client:
                page = client.get_paginated(
                    "/api/network/ip/interfaces",
                    params={"fields": "uuid,name,ip,scope,services,svm,state"},
                )
            return {"records": page.records, "truncated": page.truncated}
        except Exception as e:
            return _ontap_error(e)


if _enabled("get_volume"):
    @mcp.tool()
    def get_volume(volume_uuid: str) -> Dict[str, Any]:
        """Fetch details for a single volume."""
        try:
            with _ontap_client() as client:
                return client.get(f"/api/storage/volumes/{volume_uuid}")
        except Exception as e:
            return _ontap_error(e)


if _enabled("get_cluster"):
    @mcp.tool()
    def get_cluster() -> Dict[str, Any]:
        """Fetch cluster metadata (name, version, nodes)."""
        try:
            with _ontap_client() as client:
                return client.get("/api/cluster")
        except Exception as e:
            return _ontap_error(e)


if _enabled("get_volume_metrics"):
    @mcp.tool()
    def get_volume_metrics(volume_uuid: str) -> Dict[str, Any]:
        """Fetch the latest IOPS / throughput / latency metrics for a volume."""
        try:
            with _ontap_client() as client:
                return client.get(f"/api/storage/volumes/{volume_uuid}/metrics")
        except Exception as e:
            return _ontap_error(e)


if _enabled("query_ems_events"):
    @mcp.tool()
    def query_ems_events(
        log_message: Optional[str] = None,
        message_severity: Optional[str] = None,
        message_name: Optional[str] = None,
        node_name: Optional[str] = None,
        filter_name: Optional[str] = None,
        max_records: Optional[int] = None,
        fields: Optional[str] = None,
        hours: Optional[float] = None,
        time_after: Optional[str] = None,
        time_before: Optional[str] = None,
        return_timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Query live EMS (Event Management System) events from the ONTAP cluster.

        Use hours (e.g. 720 for 30 days) or explicit ISO-8601 time_after/time_before to
        bound the window. Combine with message_severity and log_message wildcards (*disk*).
        Returns a live buffer — not a long-term log archive.
        """
        try:
            params, err = build_ems_events_params(
                log_message=log_message,
                message_severity=message_severity,
                message_name=message_name,
                node_name=node_name,
                filter_name=filter_name,
                max_records=max_records,
                fields=fields,
                return_timeout=return_timeout,
                hours=hours,
                time_after=time_after,
                time_before=time_before,
            )
            if err:
                return {"error": {"code": "INVALID_ARGUMENT", "message": err}}
            query = flatten_log_query_params(params)
            page_cap = int(params["max_records"])
            with _ontap_client() as client:
                page = client.get_paginated("/api/support/ems/events", params=query, max_records=page_cap)
            return {
                "records": page.records,
                "truncated": page.truncated,
                "num_records": len(page.records),
                "time_window": log_time_window_metadata(
                    params,
                    hours=hours,
                    time_after=time_after,
                    time_before=time_before,
                ),
            }
        except Exception as e:
            return _ontap_error(e)


if _enabled("get_ems_event"):
    @mcp.tool()
    def get_ems_event(node_name: str, index: int) -> Dict[str, Any]:
        """Fetch a single EMS event by node name and event index."""
        node = (node_name or "").strip()
        if not node:
            return {"error": {"code": "INVALID_ARGUMENT", "message": "node_name is required"}}
        try:
            event_index = int(index)
        except (TypeError, ValueError):
            return {"error": {"code": "INVALID_ARGUMENT", "message": "index must be an integer"}}
        try:
            with _ontap_client() as client:
                return client.get(f"/api/support/ems/events/{node}/{event_index}")
        except Exception as e:
            return _ontap_error(e)


if _enabled("lookup_ems_message"):
    @mcp.tool()
    def lookup_ems_message(
        name: Optional[str] = None,
        name_pattern: Optional[str] = None,
        max_records: Optional[int] = None,
        fields: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Look up EMS event definitions from the cluster catalog (name, severity, description, corrective action).

        Provide exact name or a name_pattern (ONTAP name query, e.g. disk*). Not live events — use query_ems_events for those.
        """
        if not _strip_optional(name) and not _strip_optional(name_pattern):
            return {
                "error": {
                    "code": "INVALID_ARGUMENT",
                    "message": "Provide name or name_pattern",
                }
            }
        try:
            exact_name = _strip_optional(name)
            if exact_name:
                with _ontap_client() as client:
                    return client.get(f"/api/support/ems/messages/{exact_name}")
            params = build_ems_messages_params(
                name=name,
                name_pattern=name_pattern,
                max_records=max_records,
                fields=fields,
            )
            page_cap = int(params["max_records"])
            with _ontap_client() as client:
                page = client.get_paginated("/api/support/ems/messages", params=params, max_records=page_cap)
            return {"records": page.records, "truncated": page.truncated, "num_records": len(page.records)}
        except Exception as e:
            return _ontap_error(e)


if _enabled("query_audit_messages"):
    @mcp.tool()
    def query_audit_messages(
        max_records: Optional[int] = None,
        fields: Optional[str] = None,
        hours: Optional[float] = None,
        time_after: Optional[str] = None,
        time_before: Optional[str] = None,
        return_timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Query administrative audit log records (CLI, REST, and ONTAPI management activity).

        Use hours (e.g. 720 for 30 days) or explicit ISO-8601 time_after/time_before to bound
        the window. Records include user, application, input command/API path, timestamp, and state.
        """
        try:
            params, err = build_audit_messages_params(
                max_records=max_records,
                fields=fields,
                return_timeout=return_timeout,
                hours=hours,
                time_after=time_after,
                time_before=time_before,
            )
            if err:
                return {"error": {"code": "INVALID_ARGUMENT", "message": err}}
            query = flatten_log_query_params(params)
            page_cap = int(params["max_records"])
            with _ontap_client() as client:
                page = client.get_paginated(
                    "/api/security/audit/messages",
                    params=query,
                    max_records=page_cap,
                )
            return {
                "records": page.records,
                "truncated": page.truncated,
                "num_records": len(page.records),
                "time_window": log_time_window_metadata(
                    params,
                    hours=hours,
                    time_after=time_after,
                    time_before=time_before,
                ),
            }
        except Exception as e:
            return _ontap_error(e)


# ── WRITE tools (gated; each emits structured audit) ──────────────────────────

if _enabled("create_snapshot"):
    @mcp.tool()
    def create_snapshot(volume_uuid: str, name: str, comment: Optional[str] = None) -> Dict[str, Any]:
        """Create a snapshot on the given volume."""
        args = {"volume_uuid": volume_uuid, "name": name, "comment": comment}
        _audit("create_snapshot", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request(  # type: ignore[attr-defined]
                    "POST",
                    f"/api/storage/volumes/{volume_uuid}/snapshots",
                    json_body={"name": name, **({"comment": comment} if comment else {})},
                )
            _audit("create_snapshot", args, "ok")
            return resp
        except Exception as e:
            _audit("create_snapshot", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("delete_snapshot"):
    @mcp.tool()
    def delete_snapshot(volume_uuid: str, snapshot_uuid: str) -> Dict[str, Any]:
        """Delete a snapshot from a volume."""
        args = {"volume_uuid": volume_uuid, "snapshot_uuid": snapshot_uuid}
        _audit("delete_snapshot", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request(  # type: ignore[attr-defined]
                    "DELETE", f"/api/storage/volumes/{volume_uuid}/snapshots/{snapshot_uuid}",
                )
            _audit("delete_snapshot", args, "ok")
            return resp
        except Exception as e:
            _audit("delete_snapshot", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("restore_snapshot"):
    @mcp.tool()
    def restore_snapshot(volume_uuid: str, snapshot_name: str) -> Dict[str, Any]:
        """Restore a volume to a named snapshot."""
        args = {"volume_uuid": volume_uuid, "snapshot_name": snapshot_name}
        _audit("restore_snapshot", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request(  # type: ignore[attr-defined]
                    "PATCH",
                    f"/api/storage/volumes/{volume_uuid}",
                    json_body={"restore_to": {"snapshot": {"name": snapshot_name}}},
                )
            _audit("restore_snapshot", args, "ok")
            return resp
        except Exception as e:
            _audit("restore_snapshot", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("create_volume"):
    @mcp.tool()
    def create_volume(
        svm_name: str,
        name: str,
        aggregate_name: str,
        size_bytes: int,
        junction_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a volume on a given SVM and aggregate."""
        args = {
            "svm_name": svm_name,
            "name": name,
            "aggregate_name": aggregate_name,
            "size_bytes": size_bytes,
            "junction_path": junction_path,
        }
        _audit("create_volume", args, "started")
        try:
            body: Dict[str, Any] = {
                "name": name,
                "svm": {"name": svm_name},
                "aggregates": [{"name": aggregate_name}],
                "size": size_bytes,
            }
            if junction_path:
                body["nas"] = {"path": junction_path}
            with _ontap_client() as client:
                resp = client._request("POST", "/api/storage/volumes", json_body=body)  # type: ignore[attr-defined]
            _audit("create_volume", args, "ok")
            return resp
        except Exception as e:
            _audit("create_volume", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("delete_volume"):
    @mcp.tool()
    def delete_volume(volume_uuid: str) -> Dict[str, Any]:
        """Delete a volume by UUID."""
        args = {"volume_uuid": volume_uuid}
        _audit("delete_volume", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request("DELETE", f"/api/storage/volumes/{volume_uuid}")  # type: ignore[attr-defined]
            _audit("delete_volume", args, "ok")
            return resp
        except Exception as e:
            _audit("delete_volume", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("resize_volume"):
    @mcp.tool()
    def resize_volume(volume_uuid: str, new_size_bytes: int) -> Dict[str, Any]:
        """Resize an existing volume."""
        args = {"volume_uuid": volume_uuid, "new_size_bytes": new_size_bytes}
        _audit("resize_volume", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request(  # type: ignore[attr-defined]
                    "PATCH",
                    f"/api/storage/volumes/{volume_uuid}",
                    json_body={"size": new_size_bytes},
                )
            _audit("resize_volume", args, "ok")
            return resp
        except Exception as e:
            _audit("resize_volume", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("set_volume_qos"):
    @mcp.tool()
    def set_volume_qos(volume_uuid: str, policy_name: str) -> Dict[str, Any]:
        """Attach a QoS policy to a volume."""
        args = {"volume_uuid": volume_uuid, "policy_name": policy_name}
        _audit("set_volume_qos", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request(  # type: ignore[attr-defined]
                    "PATCH",
                    f"/api/storage/volumes/{volume_uuid}",
                    json_body={"qos": {"policy": {"name": policy_name}}},
                )
            _audit("set_volume_qos", args, "ok")
            return resp
        except Exception as e:
            _audit("set_volume_qos", args, "failed", error=str(e))
            return _ontap_error(e)


if _enabled("set_export_policy"):
    @mcp.tool()
    def set_export_policy(volume_uuid: str, export_policy_name: str) -> Dict[str, Any]:
        """Attach an existing export policy to a volume."""
        args = {"volume_uuid": volume_uuid, "export_policy_name": export_policy_name}
        _audit("set_export_policy", args, "started")
        try:
            with _ontap_client() as client:
                resp = client._request(  # type: ignore[attr-defined]
                    "PATCH",
                    f"/api/storage/volumes/{volume_uuid}",
                    json_body={"nas": {"export_policy": {"name": export_policy_name}}},
                )
            _audit("set_export_policy", args, "ok")
            return resp
        except Exception as e:
            _audit("set_export_policy", args, "failed", error=str(e))
            return _ontap_error(e)


if __name__ == "__main__":
    logger.info("Starting ONTAP MCP server (allowed tools: %s)", sorted(ALLOWED))
    mcp.run()
