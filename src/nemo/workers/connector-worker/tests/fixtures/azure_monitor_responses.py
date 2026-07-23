"""Redacted Azure Monitor Metrics API fixtures for ANF volume metrics tests.

Phase 0 spike notes (Azure Monitor Metrics List API, subscription-scoped query)
=============================================================================

Live spike status
-----------------
No live Azure dev subscription was available in the implementation environment
(``az`` CLI absent; no service-principal env vars). Fixtures below are derived
from:

1. Azure Monitor Metrics ``list`` REST response schema (api-version 2023-10-01)
2. Supported metrics for ``Microsoft.NetApp/netAppAccounts/capacityPools/volumes``
   (metric API names: ReadIops, WriteIops, ReadThroughput, WriteThroughput,
   AverageReadLatency, AverageWriteLatency, VolumeLogicalSize, VolumeAllocatedSize,
   VolumeSnapshotSize)
3. Deserialization path in ``azure-monitor-query`` 1.x
   (``MetricsQueryResult._from_generated`` → ``Metric._from_generated``)

Replace or amend these payloads after a successful live spike; portal parity is
the exit criterion.

ARM resource ID format observed (documented + fixture shape)
------------------------------------------------------------
Volume resource (before ``/providers/Microsoft.Insights/...``):

  /subscriptions/{subscription_id}/resourceGroups/{resource_group}/providers/
  Microsoft.NetApp/netAppAccounts/{account}/capacityPools/{pool}/volumes/{volume}

Metric result ``id`` embeds the volume ARM path plus Insights suffix, e.g.:

  .../volumes/{volume}/providers/Microsoft.Insights/metrics/ReadIops

Deriving volume_name and volume_id
----------------------------------
- ``volume_name``: final path segment after ``.../volumes/`` (case may be
  ``volumes`` or ``Volumes`` in some API revisions; adapter normalizes).
- ``volume_id``: full volume ARM path (subscription through ``.../volumes/{name}``),
  without the ``/providers/Microsoft.Insights/...`` suffix. No separate
  dimension is required for volume identity at subscription scope.

Metric API names vs portal labels
---------------------------------
| Portal label              | API name            | Unit            |
|---------------------------|---------------------|-----------------|
| Read IOPS                 | ReadIops            | CountPerSecond  |
| Write IOPS                | WriteIops           | CountPerSecond  |
| Read Throughput           | ReadThroughput      | BytesPerSecond  |
| Write Throughput          | WriteThroughput     | BytesPerSecond  |
| Avg read latency          | AverageReadLatency  | MilliSeconds    |
| Avg write latency         | AverageWriteLatency | MilliSeconds    |
| Volume logical size       | VolumeLogicalSize   | Bytes           |
| Volume allocated size     | VolumeAllocatedSize | Bytes           |
| Volume snapshot size      | VolumeSnapshotSize  | Bytes           |

Auth / RBAC (expected during live spike)
----------------------------------------
- Service principal needs **Monitoring Reader** on the subscription (or resource).
- **Reader** on NetApp volumes may be needed to resolve resources in some tenants.
- Typical failure: 403 on metrics list → assign Monitoring Reader at subscription scope.

Query parameters used in spike script (for live validation)
-------------------------------------------------------------
- resource_uri: ``/subscriptions/{subscription_id}``
- metric_namespace: ``Microsoft.NetApp/netAppAccounts/capacityPools/volumes``
- interval: ``PT5M``
- timespan: last 24 hours
- aggregations: Average (default for these counters)
"""
from __future__ import annotations

from typing import Any, Dict, List

from azure.monitor.query import MetricsQueryResult

_SUB = "00000000-0000-0000-0000-000000000001"
_RG = "rg-anf-dev"
_ACCOUNT = "anf-account-01"
_POOL = "pool1"
_VOL1 = "vol-metrics-a"
_VOL2 = "vol-metrics-b"
_TS1 = "2026-05-31T12:00:00Z"
_TS2 = "2026-05-31T12:05:00Z"


def _volume_base(volume: str) -> str:
    return (
        f"/subscriptions/{_SUB}/resourceGroups/{_RG}/providers/Microsoft.NetApp/"
        f"netAppAccounts/{_ACCOUNT}/capacityPools/{_POOL}/volumes/{volume}"
    )


def _pool_arm_id() -> str:
    return (
        f"/subscriptions/{_SUB}/resourceGroups/{_RG}/providers/Microsoft.NetApp/"
        f"netAppAccounts/{_ACCOUNT}/capacityPools/{_POOL}"
    )


def _metric_block(metric_name: str, volume: str, points: List[Dict[str, Any]]) -> Dict[str, Any]:
    base = _volume_base(volume)
    unit = "Bytes" if metric_name.startswith("Volume") else (
        "MilliSeconds" if "Latency" in metric_name else "BytesPerSecond"
        if "Throughput" in metric_name else "CountPerSecond"
    )
    return {
        "id": f"{base}/providers/Microsoft.Insights/metrics/{metric_name}",
        "type": "Microsoft.Insights/metrics",
        "name": {"value": metric_name, "localizedValue": metric_name},
        "displayDescription": f"ANF {metric_name}",
        "unit": unit,
        "timeseries": [{"metadatavalues": [], "data": points}],
        "errorCode": "Success",
    }


def _points(values: List[float]) -> List[Dict[str, Any]]:
    stamps = [_TS1, _TS2][: len(values)]
    return [
        {"timeStamp": stamps[i], "average": values[i], "minimum": values[i], "maximum": values[i]}
        for i in range(len(values))
    ]


def _response_body(metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "cost": 0,
        "timespan": f"{_TS1}/{_TS2}",
        "interval": "PT5M",
        "namespace": "Microsoft.NetApp/netAppAccounts/capacityPools/volumes",
        "resourceregion": "eastus",
        "value": metrics,
    }


def metrics_query_result_from_body(body: Dict[str, Any]) -> MetricsQueryResult:
    """Build a MetricsQueryResult the same way the Azure SDK does."""
    return MetricsQueryResult._from_generated(body)  # pylint: disable=protected-access


# One volume, full v2 volume_metrics mapping (happy-path acquisition).
SINGLE_VOLUME_RAW: Dict[str, Any] = _response_body(
    [
        _metric_block("ReadIops", _VOL1, _points([120.0, 130.0])),
        _metric_block("WriteIops", _VOL1, _points([80.0, 90.0])),
        _metric_block("OtherIops", _VOL1, _points([5.0, 6.0])),
        _metric_block("TotalIops", _VOL1, _points([205.0, 226.0])),
        _metric_block("ReadThroughput", _VOL1, _points([1.5e6, 1.6e6])),
        _metric_block("WriteThroughput", _VOL1, _points([900000.0, 950000.0])),
        _metric_block("OtherThroughput", _VOL1, _points([10000.0, 11000.0])),
        _metric_block("TotalThroughput", _VOL1, _points([2.41e6, 2.561e6])),
        _metric_block("AverageReadLatency", _VOL1, _points([2.5, 2.4])),
        _metric_block("AverageWriteLatency", _VOL1, _points([3.1, 3.0])),
        _metric_block("VolumeLogicalSize", _VOL1, _points([1.0e12, 1.01e12])),
        _metric_block("VolumeAllocatedSize", _VOL1, _points([2.0e12, 2.0e12])),
        _metric_block("VolumeSnapshotSize", _VOL1, _points([5.0e10, 5.1e10])),
        _metric_block("VolumeConsumedSizePercentage", _VOL1, _points([50.0, 50.5])),
        _metric_block("VolumeInodesUsed", _VOL1, _points([1000.0, 1010.0])),
        _metric_block("VolumeInodesTotal", _VOL1, _points([5000.0, 5000.0])),
        _metric_block("VolumeInodesPercentage", _VOL1, _points([20.0, 20.2])),
        _metric_block("ThroughputLimitReached", _VOL1, _points([0.0, 1.0])),
        _metric_block("QosLatencyDelta", _VOL1, _points([0.5, 0.6])),
        _metric_block("VolumeCoolTierDataReadSize", _VOL1, _points([1.0e9, 1.1e9])),
        _metric_block("VolumeCoolTierDataWriteSize", _VOL1, _points([2.0e8, 2.1e8])),
        _metric_block("VolumeCoolTierSize", _VOL1, _points([3.0e10, 3.1e10])),
    ]
)


def _pool_response_body(metrics: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "cost": 0,
        "timespan": f"{_TS1}/{_TS2}",
        "interval": "PT5M",
        "namespace": "Microsoft.NetApp/netAppAccounts/capacityPools",
        "resourceregion": "eastus",
        "value": metrics,
    }


def _pool_metric_block(metric_name: str, points: List[Dict[str, Any]]) -> Dict[str, Any]:
    pool_base = (
        f"/subscriptions/{_SUB}/resourceGroups/{_RG}/providers/Microsoft.NetApp/"
        f"netAppAccounts/{_ACCOUNT}/capacityPools/{_POOL}"
    )
    unit = "Bytes" if "Size" in metric_name or "Used" in metric_name else "BytesPerSecond"
    return {
        "id": f"{pool_base}/providers/Microsoft.Insights/metrics/{metric_name}",
        "type": "Microsoft.Insights/metrics",
        "name": {"value": metric_name, "localizedValue": metric_name},
        "displayDescription": f"ANF pool {metric_name}",
        "unit": unit,
        "timeseries": [{"metadatavalues": [], "data": points}],
        "errorCode": "Success",
    }


SINGLE_POOL_RAW: Dict[str, Any] = _pool_response_body(
    [
        _pool_metric_block("VolumePoolAllocatedSize", _points([4.0e12, 4.0e12])),
        _pool_metric_block("VolumePoolAllocatedUsed", _points([2.5e12, 2.6e12])),
        _pool_metric_block("VolumePoolTotalLogicalSize", _points([1.8e12, 1.85e12])),
    ]
)

# Two volumes in the same response (subscription-scoped query).
MULTI_VOLUME_RAW: Dict[str, Any] = _response_body(
    [
        _metric_block("ReadIops", _VOL1, _points([100.0])),
        _metric_block("ReadIops", _VOL2, _points([200.0])),
        _metric_block("WriteIops", _VOL1, _points([50.0])),
        _metric_block("WriteIops", _VOL2, _points([60.0])),
    ]
)

EMPTY_RAW: Dict[str, Any] = _response_body([])

# Shape captured when RBAC denies metrics read (REST error body; tests raise HttpResponseError).
AUTH_ERROR_BODY: Dict[str, Any] = {
    "error": {
        "code": "AuthorizationFailed",
        "message": (
            "The client does not have authorization to perform action "
            "'Microsoft.Insights/metrics/read'."
        ),
    }
}

SINGLE_VOLUME = metrics_query_result_from_body(SINGLE_VOLUME_RAW)
MULTI_VOLUME = metrics_query_result_from_body(MULTI_VOLUME_RAW)
EMPTY = metrics_query_result_from_body(EMPTY_RAW)
SINGLE_POOL = metrics_query_result_from_body(SINGLE_POOL_RAW)

FIXTURE_SUBSCRIPTION_ID = _SUB
FIXTURE_NETAPP_ACCOUNT = _ACCOUNT
FIXTURE_POOL_NAME = _POOL
FIXTURE_POOL_ARM_ID = _pool_arm_id()
FIXTURE_VOLUME_NAME = _VOL1
FIXTURE_VOLUME_ARM_ID = _volume_base(_VOL1)
