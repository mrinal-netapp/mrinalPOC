"""Integration tests for ANF MCP resize (live Azure).

Requires ANF_INTEGRATION=1 and service principal env vars:
  AZURE_SUBSCRIPTION_ID, AZURE_DEFAULT_REGION,
  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
  ANF_TEST_POOL_ARM_ID, ANF_TEST_VOLUME_ARM_ID

RBAC: Microsoft.NetApp/netAppAccounts/capacityPools/write and volumes/write.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from anf_common import AnfClient, MIN_POOL_SIZE_BYTES, MIN_VOLUME_USAGE_THRESHOLD_BYTES, build_credential  # noqa: E402

pytestmark = pytest.mark.skipif(
    os.environ.get("ANF_INTEGRATION") != "1",
    reason="Set ANF_INTEGRATION=1 to run live Azure tests",
)


def _integration_client() -> AnfClient:
    subscription_id = os.environ["AZURE_SUBSCRIPTION_ID"]
    region = os.environ["AZURE_DEFAULT_REGION"]
    credential = {
        "tenant_id": os.environ["AZURE_TENANT_ID"],
        "client_id": os.environ["AZURE_CLIENT_ID"],
        "client_secret": os.environ["AZURE_CLIENT_SECRET"],
    }
    build_credential(credential)
    return AnfClient(
        credential,
        subscription_id=subscription_id,
        region=region,
        resource_group=os.environ.get("AZURE_RESOURCE_GROUP", ""),
    )


def test_get_pool_and_grow_pool():
    pool_id = os.environ["ANF_TEST_POOL_ARM_ID"]
    client = _integration_client()
    pool = client.get_capacity_pool(pool_id)
    current = int((pool.get("properties") or {}).get("size") or MIN_POOL_SIZE_BYTES)
    grown = max(current * 2, MIN_POOL_SIZE_BYTES * 2)
    updated = client.patch_capacity_pool_size(pool_id, grown)
    assert int((updated.get("properties") or {}).get("size") or 0) >= grown


def test_get_volume_and_grow_volume():
    volume_id = os.environ["ANF_TEST_VOLUME_ARM_ID"]
    client = _integration_client()
    vol = client.get_volume(volume_id)
    current = int((vol.get("properties") or {}).get("usageThreshold") or MIN_VOLUME_USAGE_THRESHOLD_BYTES)
    grown = max(current * 2, MIN_VOLUME_USAGE_THRESHOLD_BYTES * 2)
    updated = client.patch_volume_usage_threshold(volume_id, grown)
    assert int((updated.get("properties") or {}).get("usageThreshold") or 0) >= grown
