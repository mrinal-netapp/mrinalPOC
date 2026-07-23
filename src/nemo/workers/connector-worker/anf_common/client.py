"""Azure NetApp Files ARM client (list/get/patch).

Shared by the connector-worker metrics adapter and the in-tree mcp-server-anf
image. No Temporal or MCP dependencies.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Mapping, Optional

import requests

from .arm import (
    ARM_BASE,
    ARM_TOKEN_SCOPE,
    MIN_POOL_SIZE_BYTES,
    NETAPP_API_VERSION,
    RESOURCE_GRAPH_API_VERSION,
    build_pool_arm_id,
    kql_string_literal,
    normalize_region,
    parse_pool_resource_id,
    parse_resource_id,
    pool_patch_body,
    resource_group_from_arm,
    validate_region_slug,
    validate_subscription_id,
    volume_context_from_parsed,
    volume_patch_body,
)
from .errors import AnfAuthError, AnfHTTPError, AnfValidationError

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 60.0


def build_credential(credential: Mapping[str, str]) -> Any:
    """Build Azure ClientSecretCredential from resolved credential keys."""
    tenant_id = (credential.get("tenant_id") or "").strip()
    client_id = (credential.get("client_id") or "").strip()
    client_secret = (credential.get("client_secret") or "").strip()
    missing = [
        k
        for k, v in (
            ("tenant_id", tenant_id),
            ("client_id", client_id),
            ("client_secret", client_secret),
        )
        if not v
    ]
    if missing:
        raise ValueError(
            f"[Anf] credential missing required keys: {', '.join(missing)}"
        )
    try:
        from azure.identity import ClientSecretCredential
    except ImportError as e:
        raise RuntimeError(
            "[Anf] azure-identity is not installed. "
            "Add azure-identity to requirements.txt and rebuild."
        ) from e
    return ClientSecretCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        client_secret=client_secret,
    )


def arm_bearer_token(credential: Any) -> str:
    return credential.get_token(ARM_TOKEN_SCOPE).token


def _raise_for_status(resp: requests.Response) -> None:
    if resp.status_code in (401, 403):
        raise AnfAuthError(
            f"Azure ARM returned {resp.status_code}: {resp.text[:500]}",
            status=resp.status_code,
        )
    if resp.status_code >= 400:
        raise AnfHTTPError(
            f"Azure ARM returned {resp.status_code}: {resp.text[:500]}",
            status=resp.status_code,
        )


class AnfClient:
    """Stateless ANF ARM client for one-shot method calls."""

    def __init__(
        self,
        credential: Mapping[str, str],
        *,
        subscription_id: str,
        region: str,
        resource_group: str = "",
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._credential_dict = dict(credential)
        self._azure_cred: Optional[Any] = None
        raw_subscription_id = subscription_id.strip()
        raw_region = region.strip()
        if not raw_subscription_id:
            raise ValueError("subscription_id is required")
        if not raw_region:
            raise ValueError("region is required (e.g. eastus)")
        self.subscription_id = validate_subscription_id(raw_subscription_id)
        self.region = validate_region_slug(raw_region)
        self.resource_group = (resource_group or "").strip()
        self.timeout = float(timeout)

    def _cred(self) -> Any:
        if self._azure_cred is None:
            self._azure_cred = build_credential(self._credential_dict)
        return self._azure_cred

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {arm_bearer_token(self._cred())}"}

    def _get(self, path: str) -> Dict[str, Any]:
        url = f"{ARM_BASE}{path}" if path.startswith("/") else path
        resp = requests.get(
            url,
            headers=self._headers(),
            params={"api-version": NETAPP_API_VERSION},
            timeout=self.timeout,
        )
        _raise_for_status(resp)
        return resp.json()

    def _patch(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{ARM_BASE}{path}" if path.startswith("/") else path
        resp = requests.patch(
            url,
            headers={**self._headers(), "Content-Type": "application/json"},
            params={"api-version": NETAPP_API_VERSION},
            json=body,
            timeout=self.timeout,
        )
        _raise_for_status(resp)
        return resp.json()

    def list_volumes_resource_graph(
        self,
        *,
        subscription_id: Optional[str] = None,
        region: Optional[str] = None,
        resource_group: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """List ANF volume ARM paths via Resource Graph."""
        sub = validate_subscription_id((subscription_id or self.subscription_id).strip())
        region_n = validate_region_slug(region or self.region)
        rg = (resource_group if resource_group is not None else self.resource_group).strip()
        query_lines = [
            "Resources",
            "| where type =~ 'microsoft.netapp/netappaccounts/capacitypools/volumes'",
            f"| where subscriptionId == '{kql_string_literal(sub)}'",
            f"| where tolower(location) == '{kql_string_literal(region_n)}'",
        ]
        if rg:
            query_lines.append(
                f"| where resourceGroup =~ '{kql_string_literal(rg)}'"
            )
        query_lines.append("| project id, name, resourceGroup")
        query = "\n".join(query_lines)

        url = f"{ARM_BASE}/providers/Microsoft.ResourceGraph/resources"
        resp = requests.post(
            url,
            params={"api-version": RESOURCE_GRAPH_API_VERSION},
            headers=self._headers(),
            json={"subscriptions": [sub], "query": query},
            timeout=self.timeout,
        )
        if resp.status_code in (401, 403, 404):
            logger.info(
                "[Anf] Resource Graph unavailable (status=%s); using ARM enumeration",
                resp.status_code,
            )
            return []
        _raise_for_status(resp)
        volumes: List[Dict[str, str]] = []
        for row in resp.json().get("data", []):
            arm_id = (row.get("id") or "").strip()
            parsed = parse_resource_id(arm_id)
            if parsed:
                volumes.append(volume_context_from_parsed(parsed))
        return volumes

    def list_volumes_arm_enumerate(
        self,
        *,
        subscription_id: Optional[str] = None,
        region: Optional[str] = None,
        resource_group: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """Fallback: walk netAppAccounts → capacityPools → volumes."""
        sub = (subscription_id or self.subscription_id).strip()
        region_n = normalize_region(region or self.region)
        rg_filter = (
            resource_group if resource_group is not None else self.resource_group
        ).strip()
        headers = self._headers()
        api = NETAPP_API_VERSION
        volumes: List[Dict[str, str]] = []

        accounts_url = (
            f"{ARM_BASE}/subscriptions/{sub}/providers/Microsoft.NetApp/netAppAccounts"
        )
        accounts_resp = requests.get(
            accounts_url, headers=headers, params={"api-version": api}, timeout=self.timeout
        )
        _raise_for_status(accounts_resp)

        for account in accounts_resp.json().get("value", []):
            account_id = (account.get("id") or "").strip()
            if not account_id:
                continue
            if normalize_region(account.get("location") or "") != region_n:
                continue
            rg = resource_group_from_arm(account_id)
            if rg_filter and rg.lower() != rg_filter.lower():
                continue

            pools_resp = requests.get(
                f"{ARM_BASE}{account_id}/capacityPools",
                headers=headers,
                params={"api-version": api},
                timeout=self.timeout,
            )
            _raise_for_status(pools_resp)
            for pool in pools_resp.json().get("value", []):
                pool_arm = (pool.get("id") or "").strip()
                if not pool_arm:
                    continue
                props = pool.get("properties") or {}
                service_level = props.get("serviceLevel") or (pool.get("sku") or {}).get(
                    "name"
                )
                vols_resp = requests.get(
                    f"{ARM_BASE}{pool_arm}/volumes",
                    headers=headers,
                    params={"api-version": api},
                    timeout=self.timeout,
                )
                _raise_for_status(vols_resp)
                for vol in vols_resp.json().get("value", []):
                    vol_id = (vol.get("id") or "").strip()
                    parsed = parse_resource_id(vol_id)
                    if parsed:
                        ctx = volume_context_from_parsed(parsed)
                        if service_level:
                            ctx["service_level"] = str(service_level)
                        volumes.append(ctx)
        return volumes

    def enrich_volumes_service_level(
        self, volumes: List[Dict[str, str]]
    ) -> List[Dict[str, str]]:
        if not volumes:
            return volumes
        headers = self._headers()
        pool_levels: Dict[str, str] = {}
        for vol in volumes:
            if vol.get("service_level"):
                continue
            pool_id = (vol.get("pool_id") or "").strip()
            if not pool_id:
                continue
            if pool_id not in pool_levels:
                resp = requests.get(
                    f"{ARM_BASE}{pool_id}",
                    headers=headers,
                    params={"api-version": NETAPP_API_VERSION},
                    timeout=self.timeout,
                )
                if resp.status_code >= 400:
                    logger.info(
                        "[Anf] could not read pool %s for service_level (status=%s)",
                        pool_id,
                        resp.status_code,
                    )
                    pool_levels[pool_id] = ""
                    continue
                pool = resp.json()
                props = pool.get("properties") or {}
                level = props.get("serviceLevel") or (pool.get("sku") or {}).get("name") or ""
                pool_levels[pool_id] = str(level) if level else ""
            level = pool_levels[pool_id]
            if level:
                vol["service_level"] = level
        return volumes

    @staticmethod
    def volume_summary_from_context(ctx: Dict[str, str]) -> Dict[str, Any]:
        """Lightweight volume row for list tools (no per-volume ARM GET)."""
        name = ctx.get("volume_name") or ""
        return {
            "volume_id": ctx.get("volume_id", ""),
            "volume_name": name,
            "name": name,
            "subscription_id": ctx.get("subscription_id", ""),
            "resource_group": ctx.get("resource_group", ""),
            "netapp_account": ctx.get("netapp_account", ""),
            "pool_name": ctx.get("pool_name", ""),
            "pool_id": ctx.get("pool_id", ""),
            "service_level": ctx.get("service_level"),
        }

    def list_volume_contexts(
        self,
        *,
        subscription_id: Optional[str] = None,
        region: Optional[str] = None,
        resource_group: Optional[str] = None,
        netapp_account: Optional[str] = None,
        enrich_service_level: bool = False,
    ) -> List[Dict[str, str]]:
        """Return distinct volume identity contexts (same discovery as metrics adapter)."""
        sub = subscription_id or self.subscription_id
        reg = region or self.region
        rg = resource_group if resource_group is not None else self.resource_group

        contexts = self.list_volumes_resource_graph(
            subscription_id=sub, region=reg, resource_group=rg
        )
        if not contexts:
            contexts = self.list_volumes_arm_enumerate(
                subscription_id=sub, region=reg, resource_group=rg
            )
        seen: Dict[str, Dict[str, str]] = {}
        for vol in contexts:
            seen[vol["volume_id"]] = vol
        contexts = list(seen.values())
        if enrich_service_level:
            contexts = self.enrich_volumes_service_level(contexts)

        if netapp_account:
            acct_lower = netapp_account.strip().lower()
            contexts = [
                v for v in contexts if v.get("netapp_account", "").lower() == acct_lower
            ]
        return contexts

    def list_volumes(
        self,
        *,
        subscription_id: Optional[str] = None,
        region: Optional[str] = None,
        resource_group: Optional[str] = None,
        netapp_account: Optional[str] = None,
        full_resource: bool = False,
    ) -> List[Dict[str, Any]]:
        """List volumes. Default is summary rows; use get_volume for full ARM payload."""
        contexts = self.list_volume_contexts(
            subscription_id=subscription_id,
            region=region,
            resource_group=resource_group,
            netapp_account=netapp_account,
        )
        if not full_resource:
            return [self.volume_summary_from_context(ctx) for ctx in contexts]

        results: List[Dict[str, Any]] = []
        for ctx in contexts:
            try:
                results.append(self.get_volume(ctx["volume_id"]))
            except AnfHTTPError as e:
                logger.warning("[Anf] skip volume %s: %s", ctx.get("volume_id"), e)
        return results

    def get_volume(self, volume_arm_id: str) -> Dict[str, Any]:
        path = volume_arm_id.strip()
        if not path.startswith("/"):
            raise AnfValidationError("volume_arm_id must be a full ARM resource path")
        if not parse_resource_id(path):
            raise AnfValidationError(f"invalid volume ARM id: {path}")
        return self._get(path)

    def list_capacity_pools_arm_enumerate(
        self,
        *,
        subscription_id: Optional[str] = None,
        region: Optional[str] = None,
        resource_group: Optional[str] = None,
        netapp_account: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        sub = (subscription_id or self.subscription_id).strip()
        region_n = normalize_region(region or self.region)
        rg_filter = (
            resource_group if resource_group is not None else self.resource_group
        ).strip()
        acct_filter = (netapp_account or "").strip().lower()
        headers = self._headers()
        api = NETAPP_API_VERSION
        pools: List[Dict[str, Any]] = []

        accounts_url = (
            f"{ARM_BASE}/subscriptions/{sub}/providers/Microsoft.NetApp/netAppAccounts"
        )
        accounts_resp = requests.get(
            accounts_url, headers=headers, params={"api-version": api}, timeout=self.timeout
        )
        _raise_for_status(accounts_resp)

        for account in accounts_resp.json().get("value", []):
            account_id = (account.get("id") or "").strip()
            if not account_id:
                continue
            if normalize_region(account.get("location") or "") != region_n:
                continue
            rg = resource_group_from_arm(account_id)
            if rg_filter and rg.lower() != rg_filter.lower():
                continue
            acct_name = account.get("name") or ""
            if acct_filter and acct_name.lower() != acct_filter:
                continue

            pools_resp = requests.get(
                f"{ARM_BASE}{account_id}/capacityPools",
                headers=headers,
                params={"api-version": api},
                timeout=self.timeout,
            )
            _raise_for_status(pools_resp)
            for pool in pools_resp.json().get("value", []):
                pools.append(pool)
        return pools

    def list_capacity_pools(
        self,
        *,
        subscription_id: Optional[str] = None,
        region: Optional[str] = None,
        resource_group: Optional[str] = None,
        netapp_account: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        return self.list_capacity_pools_arm_enumerate(
            subscription_id=subscription_id,
            region=region,
            resource_group=resource_group,
            netapp_account=netapp_account,
        )

    def resolve_pool_arm_id(
        self,
        pool_arm_id: Optional[str] = None,
        *,
        subscription_id: Optional[str] = None,
        resource_group: Optional[str] = None,
        netapp_account: Optional[str] = None,
        pool_name: Optional[str] = None,
    ) -> str:
        if pool_arm_id and pool_arm_id.strip():
            path = pool_arm_id.strip()
            if not parse_pool_resource_id(path):
                raise AnfValidationError(f"invalid pool ARM id: {path}")
            return path
        sub = (subscription_id or self.subscription_id).strip()
        rg = (resource_group or self.resource_group).strip()
        acct = (netapp_account or "").strip()
        pool = (pool_name or "").strip()
        missing = [
            n
            for n, v in (
                ("subscription_id", sub),
                ("resource_group", rg),
                ("netapp_account", acct),
                ("pool_name", pool),
            )
            if not v
        ]
        if missing:
            raise AnfValidationError(
                "provide pool_arm_id or all of: subscription_id, resource_group, "
                f"netapp_account, pool_name (missing: {', '.join(missing)})"
            )
        return build_pool_arm_id(sub, rg, acct, pool)

    def get_capacity_pool(
        self,
        pool_arm_id: Optional[str] = None,
        *,
        subscription_id: Optional[str] = None,
        resource_group: Optional[str] = None,
        netapp_account: Optional[str] = None,
        pool_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        path = self.resolve_pool_arm_id(
            pool_arm_id,
            subscription_id=subscription_id,
            resource_group=resource_group,
            netapp_account=netapp_account,
            pool_name=pool_name,
        )
        return self._get(path)

    def validate_pool_resize(self, size_bytes: int, *, allow_shrink: bool = False) -> None:
        if size_bytes < MIN_POOL_SIZE_BYTES:
            raise AnfValidationError(
                f"pool size must be at least {MIN_POOL_SIZE_BYTES} bytes (1 TiB); "
                f"got {size_bytes}"
            )

    def patch_capacity_pool_size(
        self,
        pool_arm_id: str,
        size_bytes: int,
        *,
        allow_shrink: bool = False,
    ) -> Dict[str, Any]:
        path = self.resolve_pool_arm_id(pool_arm_id)
        current = self._get(path)
        current_size = int((current.get("properties") or {}).get("size") or 0)
        self.validate_pool_resize(size_bytes)
        if not allow_shrink and current_size and size_bytes < current_size:
            raise AnfValidationError(
                "shrinking pool size requires allow_shrink=true; "
                f"current={current_size} requested={size_bytes}"
            )
        return self._patch(path, pool_patch_body(size_bytes))

    def patch_volume_usage_threshold(
        self,
        volume_arm_id: str,
        usage_threshold_bytes: int,
    ) -> Dict[str, Any]:
        """PATCH volume usageThreshold; Azure enforces min/max and shrink rules."""
        path = volume_arm_id.strip()
        if not parse_resource_id(path):
            raise AnfValidationError(f"invalid volume ARM id: {path}")
        if usage_threshold_bytes <= 0:
            raise AnfValidationError("usage_threshold_bytes must be a positive integer")
        return self._patch(path, volume_patch_body(usage_threshold_bytes))
