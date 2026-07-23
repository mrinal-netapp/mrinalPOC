"""Derive gateway service base URLs from API_BASE_URL (/config)."""

from __future__ import annotations


def gateway_roots(config_base_url: str) -> dict[str, str]:
    base = config_base_url.rstrip("/")
    if base.endswith("/config"):
        root = base[: -len("/config")]
    else:
        root = base
    return {
        "config": base,
        "workflow": f"{root}/workflow",
        "analytics": f"{root}/analytics",
        "kb": f"{root}/kb",
    }
