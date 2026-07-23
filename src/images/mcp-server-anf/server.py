"""Azure NetApp Files (ANF) MCP server.

Read tools are always registered when allowed; write tools (resize) require
``ANF_ALLOWED_TOOLS``. Every write emits structured audit JSON before ARM PATCH.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP

from anf_common import (
    AnfAuthError,
    AnfClient,
    AnfError,
    AnfHTTPError,
    AnfValidationError,
    build_credential,
)

logger = logging.getLogger("anf-mcp")
_log_level = (os.environ.get("LOG_LEVEL") or "WARNING").upper()
logging.basicConfig(level=_log_level)
# Azure SDK HTTP trace at INFO is very noisy and increases memory/CPU under load.
logging.getLogger("azure").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)

_CLIENT_CACHE: Optional[AnfClient] = None

READ_TOOLS = {
    "anf_capacity_pool_list",
    "anf_capacity_pool_get",
    "anf_volume_list",
    "anf_volume_get",
}

WRITE_TOOLS = {
    "anf_resize_capacity_pool",
    "anf_resize_volume",
}

ALL_TOOLS = READ_TOOLS | WRITE_TOOLS

_AUDIT_REDACT_KEYS = {"password", "token", "secret", "client_secret"}


def _allowed_tools() -> set[str]:
    raw = (os.environ.get("ANF_ALLOWED_TOOLS") or "").strip()
    if not raw:
        return set(READ_TOOLS)
    requested = {t.strip() for t in raw.split(",") if t.strip()}
    valid = requested & ALL_TOOLS
    rejected = requested - ALL_TOOLS
    if rejected:
        logger.warning("Ignoring unknown tool names: %s", sorted(rejected))
    return valid or set(READ_TOOLS)


def _redact(args: Dict[str, Any]) -> Dict[str, Any]:
    redacted: Dict[str, Any] = {}
    for k, v in args.items():
        if any(rk in k.lower() for rk in _AUDIT_REDACT_KEYS):
            redacted[k] = "***"
        else:
            redacted[k] = v
    return redacted


def _audit(tool: str, args: Dict[str, Any], status: str, error: Optional[str] = None) -> None:
    record = {
        "audit": True,
        "ts": int(time.time() * 1000),
        "tool": tool,
        "args": _redact(args),
        "status": status,
        "subscription_id": os.environ.get("AZURE_SUBSCRIPTION_ID", ""),
    }
    if error:
        record["error"] = error
    line = json.dumps(record, separators=(",", ":"))
    dest = (os.environ.get("ANF_MCP_AUDIT_DEST") or "stdout").lower()
    if dest == "stderr":
        print(line, file=sys.stderr, flush=True)
    else:
        print(line, flush=True)


def _build_anf_client() -> AnfClient:
    global _CLIENT_CACHE
    if _CLIENT_CACHE is not None:
        return _CLIENT_CACHE
    subscription_id = (os.environ.get("AZURE_SUBSCRIPTION_ID") or "").strip()
    region = (os.environ.get("AZURE_DEFAULT_REGION") or "").strip()
    resource_group = (os.environ.get("AZURE_RESOURCE_GROUP") or "").strip()
    if not subscription_id:
        raise SystemExit("AZURE_SUBSCRIPTION_ID is required")
    if not region:
        raise SystemExit("AZURE_DEFAULT_REGION is required")
    credential = {
        "tenant_id": (os.environ.get("AZURE_TENANT_ID") or "").strip(),
        "client_id": (os.environ.get("AZURE_CLIENT_ID") or "").strip(),
        "client_secret": (os.environ.get("AZURE_CLIENT_SECRET") or "").strip(),
    }
    build_credential(credential)
    _CLIENT_CACHE = AnfClient(
        credential,
        subscription_id=subscription_id,
        region=region,
        resource_group=resource_group,
    )
    return _CLIENT_CACHE


def _anf_error(e: Exception) -> Dict[str, Any]:
    if isinstance(e, AnfAuthError):
        return {"ok": False, "error": {"code": e.code, "message": str(e)}}
    if isinstance(e, AnfValidationError):
        return {"ok": False, "error": {"code": e.code, "message": str(e)}}
    if isinstance(e, (AnfHTTPError, AnfError)):
        return {"ok": False, "error": {"code": e.code, "message": str(e)}}
    return {"ok": False, "error": {"code": "PROVIDER_ERROR", "message": str(e)}}


def _ok(data: Any) -> Dict[str, Any]:
    return {"ok": True, "data": data}


mcp = FastMCP("anf")
ALLOWED = _allowed_tools()


def _enabled(name: str) -> bool:
    return name in ALLOWED


if _enabled("anf_capacity_pool_list"):

    @mcp.tool()
    def anf_capacity_pool_list(
        netapp_account: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List ANF capacity pools in the configured Azure scope (optional netapp_account filter)."""
        try:
            client = _build_anf_client()
            pools = client.list_capacity_pools(netapp_account=netapp_account)
            return _ok({"records": pools, "count": len(pools)})
        except Exception as e:
            return _anf_error(e)


if _enabled("anf_capacity_pool_get"):

    @mcp.tool()
    def anf_capacity_pool_get(
        pool_arm_id: Optional[str] = None,
        netapp_account: Optional[str] = None,
        pool_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get one capacity pool by ARM path or configured-scope name components."""
        try:
            client = _build_anf_client()
            pool = client.get_capacity_pool(
                pool_arm_id,
                netapp_account=netapp_account,
                pool_name=pool_name,
            )
            return _ok(pool)
        except Exception as e:
            return _anf_error(e)


if _enabled("anf_volume_list"):

    @mcp.tool()
    def anf_volume_list(
        netapp_account: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List ANF volumes in the configured Azure scope (summary rows; use anf_volume_get for full ARM)."""
        try:
            client = _build_anf_client()
            volumes = client.list_volumes(netapp_account=netapp_account)
            return _ok({"records": volumes, "count": len(volumes)})
        except Exception as e:
            return _anf_error(e)


if _enabled("anf_volume_get"):

    @mcp.tool()
    def anf_volume_get(volume_arm_id: str) -> Dict[str, Any]:
        """Get one ANF volume by full ARM resource id."""
        try:
            client = _build_anf_client()
            return _ok(client.get_volume(volume_arm_id))
        except Exception as e:
            return _anf_error(e)


if _enabled("anf_resize_capacity_pool"):

    @mcp.tool()
    def anf_resize_capacity_pool(
        pool_arm_id: str,
        size_bytes: int,
        allow_shrink: bool = False,
    ) -> Dict[str, Any]:
        """PATCH capacity pool properties.size (bytes). Minimum 1 TiB."""
        args = {
            "pool_arm_id": pool_arm_id,
            "size_bytes": size_bytes,
            "allow_shrink": allow_shrink,
        }
        _audit("anf_resize_capacity_pool", args, "started")
        try:
            client = _build_anf_client()
            result = client.patch_capacity_pool_size(
                pool_arm_id, size_bytes, allow_shrink=allow_shrink
            )
            _audit("anf_resize_capacity_pool", args, "ok")
            return _ok(result)
        except Exception as e:
            _audit("anf_resize_capacity_pool", args, "failed", error=str(e))
            return _anf_error(e)


if _enabled("anf_resize_volume"):

    @mcp.tool()
    def anf_resize_volume(
        volume_arm_id: str,
        usage_threshold_bytes: int,
    ) -> Dict[str, Any]:
        """PATCH volume properties.usageThreshold (bytes). Azure enforces platform limits."""
        args = {
            "volume_arm_id": volume_arm_id,
            "usage_threshold_bytes": usage_threshold_bytes,
        }
        _audit("anf_resize_volume", args, "started")
        try:
            client = _build_anf_client()
            result = client.patch_volume_usage_threshold(
                volume_arm_id,
                usage_threshold_bytes,
            )
            _audit("anf_resize_volume", args, "ok")
            return _ok(result)
        except Exception as e:
            _audit("anf_resize_volume", args, "failed", error=str(e))
            return _anf_error(e)


if __name__ == "__main__":
    logger.info("Starting ANF MCP server (allowed tools: %s)", sorted(ALLOWED))
    mcp.run()
