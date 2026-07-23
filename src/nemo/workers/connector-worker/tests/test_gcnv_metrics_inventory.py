"""Tests for GCNV volume inventory enrichment (pool_id / service_level)."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from adapters.gcnv_metrics_adapter import (
    build_pool_inventory_index,
    build_volume_inventory_index,
    lookup_pool_inventory,
    lookup_volume_inventory,
    _fetch_pools_inventory,
    _fetch_volumes_inventory,
    _normalize_gcnv_tier_label,
    _pool_id_from_labels,
)


def test_build_volume_inventory_index_keys_and_pool_id():
    volumes = [
        {
            "name": "projects/123/locations/us-central1/volumes/vol-1",
            "storagePool": "projects/123/locations/us-central1/storagePools/pool-a",
            "serviceLevel": "PREMIUM",
            "volumeId": "9876543210",
            "shareName": "share1",
        },
    ]
    index = build_volume_inventory_index(volumes)

    assert index["vol-1"]["pool_id"] == "pool-a"
    assert index["vol-1"]["service_level"] == "PREMIUM"
    assert index["9876543210"]["pool_id"] == "pool-a"
    assert index["share1"]["volume_name"] == "vol-1"


def test_lookup_volume_inventory_matches_short_and_numeric_ids():
    index = build_volume_inventory_index([
        {
            "name": "projects/p/locations/us-central1/volumes/analytics-vol",
            "storagePool": "projects/p/locations/us-central1/storagePools/pool-us-central1-a",
            "serviceLevel": "FLEX",
            "volumeId": "1234567890",
        },
    ])

    by_numeric = lookup_volume_inventory(index, "1234567890", "")
    by_short = lookup_volume_inventory(index, "analytics-vol", "")
    by_name_label = lookup_volume_inventory(index, "", "analytics-vol")

    assert by_numeric["pool_id"] == "pool-us-central1-a"
    assert by_short["service_level"] == "FLEX"
    assert by_name_label["volume_name"] == "analytics-vol"


@patch("googleapiclient.discovery.build")
@patch("adapters.gcp_adapter._gcnv_locations_for_scope")
def test_fetch_volumes_inventory_lists_all_locations(mock_locations, mock_build):
    mock_locations.return_value = ["us-central1", "us-central1-a"]
    netapp_svc = MagicMock()
    mock_build.return_value = netapp_svc
    volumes_api = netapp_svc.projects.return_value.locations.return_value.volumes.return_value

    def volumes_list(parent):
        mock_req = MagicMock()
        if parent.endswith("/locations/us-central1"):
            mock_req.execute.return_value = {
                "volumes": [
                    {
                        "name": "projects/my-project/locations/us-central1/volumes/vol-regional",
                        "storagePool": "projects/123/locations/us-central1/storagePools/pool-regional",
                        "serviceLevel": "PREMIUM",
                    },
                ],
            }
        else:
            mock_req.execute.return_value = {
                "volumes": [
                    {
                        "name": "projects/my-project/locations/us-central1-a/volumes/vol-zonal",
                        "storagePool": "projects/123/locations/us-central1-a/storagePools/pool-zonal",
                        "serviceLevel": "FLEX",
                    },
                ],
            }
        return mock_req

    volumes_api.list.side_effect = volumes_list
    volumes_api.list_next.return_value = None

    index = _fetch_volumes_inventory("my-project", "us-central1", MagicMock())

    assert index["vol-regional"]["pool_id"] == "pool-regional"
    assert index["vol-zonal"]["pool_id"] == "pool-zonal"
    assert index["vol-zonal"]["service_level"] == "FLEX"


def test_normalize_gcnv_tier_label():
    assert _normalize_gcnv_tier_label("cold") == "cold"
    assert _normalize_gcnv_tier_label("non cold") == "hot"
    assert _normalize_gcnv_tier_label("hot") == "hot"


def test_build_pool_inventory_index():
    pools = [
        {
            "name": "projects/p/locations/us-central1/storagePools/pool-a",
            "serviceLevel": "PREMIUM",
        },
    ]
    index = build_pool_inventory_index(pools)
    assert index["pool-a"]["pool_name"] == "pool-a"
    assert index["pool-a"]["service_level"] == "PREMIUM"
    assert lookup_pool_inventory(index, "pool-a")["service_level"] == "PREMIUM"


def test_pool_id_from_labels():
    assert _pool_id_from_labels(
        {"storage_pool": "projects/p/locations/us-central1/storagePools/pool-a"},
        {},
    ) == "pool-a"


@patch("googleapiclient.discovery.build")
@patch("adapters.gcp_adapter._gcnv_locations_for_scope")
def test_fetch_pools_inventory(mock_locations, mock_build):
    mock_locations.return_value = ["us-central1"]
    netapp_svc = MagicMock()
    mock_build.return_value = netapp_svc
    pools_api = netapp_svc.projects.return_value.locations.return_value.storagePools.return_value
    mock_req = MagicMock()
    mock_req.execute.return_value = {
        "storagePools": [
            {
                "name": "projects/my-project/locations/us-central1/storagePools/pool-regional",
                "serviceLevel": "FLEX",
            },
        ],
    }
    pools_api.list.return_value = mock_req
    pools_api.list_next.return_value = None

    index = _fetch_pools_inventory("my-project", "us-central1", MagicMock())
    assert index["pool-regional"]["pool_name"] == "pool-regional"
    assert index["pool-regional"]["service_level"] == "FLEX"
