"""Shared Azure NetApp Files ARM client + helpers.

Canonical source for connector-worker and mcp-server-anf (vendored via
``make sync-common``).
"""
from .arm import (
    ARM_BASE,
    ARM_TOKEN_SCOPE,
    MIN_POOL_SIZE_BYTES,
    MIN_VOLUME_USAGE_THRESHOLD_BYTES,
    NETAPP_API_VERSION,
    RESOURCE_GRAPH_API_VERSION,
    build_pool_arm_id,
    build_volume_arm_id,
    kql_string_literal,
    normalize_region,
    parse_pool_resource_id,
    parse_resource_id,
    pool_patch_body,
    resource_group_from_arm,
    strip_insights_suffix,
    validate_region_slug,
    validate_subscription_id,
    volume_context_from_parsed,
    volume_patch_body,
)
from .client import AnfClient, arm_bearer_token, build_credential
from .errors import AnfAuthError, AnfError, AnfHTTPError, AnfValidationError

__all__ = [
    "ARM_BASE",
    "ARM_TOKEN_SCOPE",
    "MIN_POOL_SIZE_BYTES",
    "MIN_VOLUME_USAGE_THRESHOLD_BYTES",
    "NETAPP_API_VERSION",
    "RESOURCE_GRAPH_API_VERSION",
    "AnfAuthError",
    "AnfClient",
    "AnfError",
    "AnfHTTPError",
    "AnfValidationError",
    "arm_bearer_token",
    "build_credential",
    "build_pool_arm_id",
    "build_volume_arm_id",
    "kql_string_literal",
    "normalize_region",
    "parse_pool_resource_id",
    "parse_resource_id",
    "pool_patch_body",
    "resource_group_from_arm",
    "strip_insights_suffix",
    "validate_region_slug",
    "validate_subscription_id",
    "volume_context_from_parsed",
    "volume_patch_body",
]
