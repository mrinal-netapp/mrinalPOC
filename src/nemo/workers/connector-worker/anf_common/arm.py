"""ARM resource ID parsing and path helpers for Azure NetApp Files."""
from __future__ import annotations

import re
from typing import Any, Dict, Optional

from .errors import AnfValidationError

ARM_BASE = "https://management.azure.com"
# 2024-09-01+ supports 50 GiB minimum regular volume size (GA Dec 2024). Older
# versions (e.g. 2023-05-01) reject usageThreshold below 100 GiB.
NETAPP_API_VERSION = "2024-09-01"
RESOURCE_GRAPH_API_VERSION = "2021-03-01"
ARM_TOKEN_SCOPE = f"{ARM_BASE}/.default"

MIN_POOL_SIZE_BYTES = 1 << 40  # 1 TiB (Azure minimum capacity pool size)
MIN_VOLUME_USAGE_THRESHOLD_BYTES = 50 * (1 << 30)  # 50 GiB (regular volumes)

_VOLUME_ARM_RE = re.compile(
    r"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.NetApp/"
    r"netAppAccounts/[^/]+/capacityPools/[^/]+/volumes/[^/]+$",
    re.IGNORECASE,
)

_POOL_ARM_RE = re.compile(
    r"^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.NetApp/"
    r"netAppAccounts/[^/]+/capacityPools/[^/]+$",
    re.IGNORECASE,
)

_SUBSCRIPTION_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_REGION_SLUG_RE = re.compile(r"^[a-z0-9]+$")


def strip_insights_suffix(arm_resource_id: str) -> str:
    return arm_resource_id.split("/providers/Microsoft.Insights/")[0].split(
        "/providers/microsoft.insights/"
    )[0]


def normalize_region(region: str) -> str:
    return region.strip().lower().replace(" ", "")


def resource_group_from_arm(arm_id: str) -> str:
    parts = arm_id.strip("/").split("/")
    try:
        return parts[parts.index("resourceGroups") + 1]
    except (ValueError, IndexError):
        return ""


def kql_string_literal(value: str) -> str:
    """Escape a value for safe interpolation into a KQL single-quoted string."""
    return value.replace("'", "''")


def validate_subscription_id(value: str) -> str:
    v = value.strip()
    if not _SUBSCRIPTION_ID_RE.fullmatch(v):
        raise AnfValidationError("subscription_id must be a valid GUID")
    return v


def validate_region_slug(value: str) -> str:
    v = normalize_region(value)
    if not _REGION_SLUG_RE.fullmatch(v):
        raise AnfValidationError("region must be a valid Azure region slug")
    return v


def build_pool_arm_id(
    subscription_id: str,
    resource_group: str,
    netapp_account: str,
    pool_name: str,
) -> str:
    return (
        f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}/"
        f"providers/Microsoft.NetApp/netAppAccounts/{netapp_account}/"
        f"capacityPools/{pool_name}"
    )


def build_volume_arm_id(
    subscription_id: str,
    resource_group: str,
    netapp_account: str,
    pool_name: str,
    volume_name: str,
) -> str:
    return f"{build_pool_arm_id(subscription_id, resource_group, netapp_account, pool_name)}/volumes/{volume_name}"


def parse_resource_id(arm_resource_id: str) -> Optional[Dict[str, str]]:
    """Parse volume ARM path from a metric id or resource id."""
    if not arm_resource_id:
        return None
    path = strip_insights_suffix(arm_resource_id.strip())
    lower = path.lower()
    marker = "/volumes/"
    idx = lower.rfind(marker)
    if idx < 0:
        return None
    vol_start = idx + len(marker)
    rest = path[vol_start:]
    volume_name = rest.split("/")[0] if rest else ""
    if not volume_name:
        return None
    volume_id = path[: vol_start + len(volume_name)]
    if not _VOLUME_ARM_RE.match(volume_id):
        return None
    parts = volume_id.strip("/").split("/")
    try:
        sub_idx = parts.index("subscriptions") + 1
        rg_idx = parts.index("resourceGroups") + 1
        acct_idx = parts.index("netAppAccounts") + 1
        pool_idx = parts.index("capacityPools") + 1
    except ValueError:
        return None
    pool_name = parts[pool_idx]
    pool_id = "/" + "/".join(parts[: pool_idx + 1])
    return {
        "subscription_id": parts[sub_idx],
        "resource_group": parts[rg_idx],
        "netapp_account": parts[acct_idx],
        "pool_name": pool_name,
        "pool_id": pool_id,
        "volume_name": volume_name,
        "volume_id": volume_id,
    }


def parse_pool_resource_id(arm_resource_id: str) -> Optional[Dict[str, str]]:
    """Parse capacity pool ARM path."""
    if not arm_resource_id:
        return None
    path = arm_resource_id.strip()
    if not _POOL_ARM_RE.match(path):
        return None
    parts = path.strip("/").split("/")
    try:
        sub_idx = parts.index("subscriptions") + 1
        rg_idx = parts.index("resourceGroups") + 1
        acct_idx = parts.index("netAppAccounts") + 1
        pool_idx = parts.index("capacityPools") + 1
    except ValueError:
        return None
    pool_name = parts[pool_idx]
    pool_id = "/" + "/".join(parts[: pool_idx + 1])
    return {
        "subscription_id": parts[sub_idx],
        "resource_group": parts[rg_idx],
        "netapp_account": parts[acct_idx],
        "pool_name": pool_name,
        "pool_id": pool_id,
    }


def volume_context_from_parsed(parsed: Dict[str, str]) -> Dict[str, str]:
    ctx = {
        "subscription_id": parsed["subscription_id"],
        "resource_group": parsed["resource_group"],
        "netapp_account": parsed["netapp_account"],
        "pool_name": parsed["pool_name"],
        "pool_id": parsed["pool_id"],
        "volume_name": parsed["volume_name"],
        "volume_id": parsed["volume_id"],
    }
    if parsed.get("service_level"):
        ctx["service_level"] = parsed["service_level"]
    return ctx


def pool_patch_body(size_bytes: int) -> Dict[str, Any]:
    return {"properties": {"size": int(size_bytes)}}


def volume_patch_body(usage_threshold_bytes: int) -> Dict[str, Any]:
    return {"properties": {"usageThreshold": int(usage_threshold_bytes)}}
