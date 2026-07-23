"""GCNV Metrics Adapter — fetches volume metrics from Google Cloud Monitoring API.

Uses time-range queries (true incremental via watermark). Outputs same volume_metrics
schema as the ONTAP adapter with source_type="gcnv".
"""
import json
from observability_client_runtime import get_logger
import os
from datetime import datetime, timezone, timedelta
from typing import Any, Callable, Dict, List, Optional

import pyarrow as pa
import pyarrow.parquet as pq

from .base import ProviderAdapter, ExplorerResponse, ExplorerNode, ExplorerError
from activities.gcp_sa_json import resolve_gcp_service_account_json
from .gcp_adapter import _gcnv_monitoring_location_filter
from .metric_table_schemas import (
    POOL_METRICS_SCHEMA,
    VOLUME_METRICS_SCHEMA,
    VOLUME_TIER_METRICS_SCHEMA,
    normalize_volume_metrics_row,
    write_empty_category_parquet,
    write_empty_volume_metrics_parquet,
)

logger = get_logger()



_GCNV_ACQUIRE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _gcnv_resource_short_name(resource_name: str) -> str:
    """Return the last path segment of a GCNV resource name."""
    return resource_name.rsplit("/", 1)[-1] if resource_name else ""


def build_volume_inventory_index(volumes: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Index NetApp Volumes API records by id/name variants for Cloud Monitoring joins."""
    index: Dict[str, Dict[str, Any]] = {}
    for vol in volumes:
        full_name = vol.get("name", "") or ""
        short_name = _gcnv_resource_short_name(full_name)
        pool_id = _gcnv_resource_short_name(vol.get("storagePool", "") or "")
        record = {
            "pool_id": pool_id or None,
            "service_level": vol.get("serviceLevel") or None,
            "volume_name": short_name or None,
        }
        keys = set()
        if short_name:
            keys.add(short_name)
        if full_name:
            keys.add(full_name)
        volume_id = vol.get("volumeId")
        if volume_id is not None:
            keys.add(str(volume_id))
        share_name = vol.get("shareName")
        if share_name:
            keys.add(str(share_name))
        for key in keys:
            if key:
                index[key] = record
    return index


def lookup_volume_inventory(
    inventory: Dict[str, Dict[str, Any]],
    volume_id: str,
    volume_name: str,
) -> Optional[Dict[str, Any]]:
    """Resolve pool/service metadata for a Cloud Monitoring volume key."""
    for key in (volume_id, volume_name):
        if not key:
            continue
        hit = inventory.get(key)
        if hit is not None:
            return hit
        short = _gcnv_resource_short_name(str(key))
        if short:
            hit = inventory.get(short)
            if hit is not None:
                return hit
    return None


def _build_acquire_credentials(
    sa_json: str,
    credentials_path: str,
    scopes: List[str],
) -> tuple[Any, str]:
    """Build GCP credentials for metrics acquire (monitoring + NetApp Volumes API)."""
    from google.oauth2 import service_account as _sa

    if sa_json:
        info = json.loads(sa_json)
        creds = _sa.Credentials.from_service_account_info(info, scopes=scopes)
        return creds, f"service_account_json(client_email={info.get('client_email', '?')})"
    if credentials_path and os.path.exists(credentials_path):
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
        creds = _sa.Credentials.from_service_account_file(credentials_path, scopes=scopes)
        return creds, f"credentials_path={credentials_path}"
    return None, "ADC (no inline SA, no path) — likely to fail"


def _fetch_volumes_inventory(
    project_id: str,
    region: str,
    credentials: Any,
) -> Dict[str, Dict[str, Any]]:
    """List GCNV volumes and build volume_id/name -> pool_id lookup (ONTAP inventory pattern)."""
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    from .gcp_adapter import _gcnv_locations_for_scope

    try:
        svc = build("netapp", "v1", credentials=credentials, cache_discovery=False)
        locations = _gcnv_locations_for_scope(svc, credentials, project_id, region)
        volumes: List[Dict[str, Any]] = []
        for loc in locations:
            parent = f"projects/{project_id}/locations/{loc}"
            request = svc.projects().locations().volumes().list(parent=parent)
            while request is not None:
                response = request.execute()
                volumes.extend(response.get("volumes", []))
                request = svc.projects().locations().volumes().list_next(
                    previous_request=request,
                    previous_response=response,
                )
        index = build_volume_inventory_index(volumes)
        logger.info(
            "[GcnvMetrics] Volume inventory loaded: volumes=%d lookup_keys=%d",
            len(volumes),
            len(index),
        )
        return index
    except HttpError as exc:
        logger.warning(
            "[GcnvMetrics] NetApp Volumes inventory failed; pool_id/service_level may be null: %s",
            exc,
        )
        return {}
    except Exception as exc:
        logger.warning(
            "[GcnvMetrics] Volume inventory failed; pool_id/service_level may be null: %s",
            exc,
        )
        return {}


def _normalize_gcnv_tier_label(raw: str) -> Optional[str]:
    """Map GCNV Cloud Monitoring tier labels to canonical tier_name values."""
    if not raw:
        return None
    lower = raw.strip().lower()
    if lower == "cold":
        return "cold"
    if lower in ("hot", "non cold", "non_cold", "noncold"):
        return "hot"
    return lower.replace(" ", "_")


def build_pool_inventory_index(pools: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Index NetApp storagePools API records by short/full name for Monitoring joins."""
    index: Dict[str, Dict[str, Any]] = {}
    for pool in pools:
        full_name = pool.get("name", "") or ""
        short_name = _gcnv_resource_short_name(full_name)
        record = {
            "pool_name": short_name or None,
            "service_level": pool.get("serviceLevel") or None,
        }
        for key in (short_name, full_name):
            if key:
                index[key] = record
    return index


def lookup_pool_inventory(
    inventory: Dict[str, Dict[str, Any]],
    pool_id: str,
) -> Optional[Dict[str, Any]]:
    if not pool_id:
        return None
    hit = inventory.get(pool_id)
    if hit is not None:
        return hit
    short = _gcnv_resource_short_name(pool_id)
    if short:
        return inventory.get(short)
    return None


def _fetch_pools_inventory(
    project_id: str,
    region: str,
    credentials: Any,
) -> Dict[str, Dict[str, Any]]:
    """List GCNV storage pools for pool_name / service_level enrichment."""
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    from .gcp_adapter import _gcnv_locations_for_scope

    try:
        svc = build("netapp", "v1", credentials=credentials, cache_discovery=False)
        locations = _gcnv_locations_for_scope(svc, credentials, project_id, region)
        pools: List[Dict[str, Any]] = []
        for loc in locations:
            parent = f"projects/{project_id}/locations/{loc}"
            request = svc.projects().locations().storagePools().list(parent=parent)
            while request is not None:
                response = request.execute()
                pools.extend(response.get("storagePools", []))
                request = svc.projects().locations().storagePools().list_next(
                    previous_request=request,
                    previous_response=response,
                )
        index = build_pool_inventory_index(pools)
        logger.info(
            "[GcnvMetrics] Pool inventory loaded: pools=%d lookup_keys=%d",
            len(pools),
            len(index),
        )
        return index
    except HttpError as exc:
        logger.warning(
            "[GcnvMetrics] NetApp storagePools inventory failed; pool metadata may be null: %s",
            exc,
        )
        return {}
    except Exception as exc:
        logger.warning(
            "[GcnvMetrics] Pool inventory failed; pool metadata may be null: %s",
            exc,
        )
        return {}


def _monitoring_point_time(point: Any) -> datetime:
    et = point.interval.end_time
    if et.tzinfo is None:
        return et.replace(tzinfo=timezone.utc)
    return et.astimezone(timezone.utc)


def _monitoring_point_value(point: Any) -> float:
    v = point.value
    if v.double_value:
        return float(v.double_value)
    if v.int64_value:
        return float(v.int64_value)
    return float(v.double_value or v.int64_value or 0)


def _pool_id_from_labels(res_labels: Dict[str, str], metric_labels: Dict[str, str]) -> str:
    raw = (
        res_labels.get("storage_pool")
        or res_labels.get("storage_pool_id")
        or res_labels.get("name")
        or metric_labels.get("storage_pool")
        or ""
    )
    return _gcnv_resource_short_name(raw) if raw else ""


def _safe_heartbeat(cb: Optional[Callable[..., None]], *details: Any) -> None:
    """Heartbeat helper that swallows errors when invoked outside a Temporal activity."""
    if cb is None:
        return
    try:
        cb(*details)
    except Exception:  # pragma: no cover - heartbeat must never fail acquisition
        logger.debug("heartbeat callback raised, ignoring", exc_info=True)

# Canonical GCNV volume metrics published to Cloud Monitoring.
# Source: https://cloud.google.com/netapp/volumes/docs/monitor/cloud-monitoring-metrics
#
# Note: GCNV does NOT publish separate read_iops / write_iops streams. Instead
# `/volume/operation_count`, `/volume/throughput`, and `/volume/average_latency`
# each return one time series per operation `type` label (read|write|metadata).
# We split them out at parse time below.
#
# Metrics are sampled every 5 minutes; do not query with a window smaller than
# that or you will get 0 series back.
GCNV_VOLUME_METRIC_TYPES = [
    # Performance — split per operation type via metric.labels["type"]
    "netapp.googleapis.com/volume/operation_count",   # ops/sec
    "netapp.googleapis.com/volume/throughput",        # bytes/sec
    "netapp.googleapis.com/volume/average_latency",   # ms
    # Capacity — single series per volume
    "netapp.googleapis.com/volume/bytes_used",
    "netapp.googleapis.com/volume/allocated_bytes",
    "netapp.googleapis.com/volume/snapshot_bytes",
    # Inodes
    "netapp.googleapis.com/volume/inode_used",
    "netapp.googleapis.com/volume/inode_limit",
]

# Volume-scoped auto-tiering (Flex service). May be absent on Flex Unified ONTAP-mode.
GCNV_TIER_METRIC_TYPES = [
    "netapp.googleapis.com/volume/auto_tiering/cold_tier_read_byte_count",
    "netapp.googleapis.com/volume/auto_tiering/cold_tier_write_byte_count",
    "netapp.googleapis.com/volume/auto_tiering/tiered_bytes",
]

# Storage pool scope — also carries tier IO on Flex Unified where volume tier is absent.
GCNV_POOL_METRIC_TYPES = [
    "netapp.googleapis.com/storage_pool/capacity",
    "netapp.googleapis.com/storage_pool/allocated",
    "netapp.googleapis.com/storage_pool/auto_tiering/tiered_bytes",
    "netapp.googleapis.com/storage_pool/auto_tiering/cold_tier_read_byte_count",
    "netapp.googleapis.com/storage_pool/auto_tiering/cold_tier_write_byte_count",
    "netapp.googleapis.com/storage_pool/replication_status",
]

# Back-compat alias for tests / callers.
GCNV_METRIC_TYPES = GCNV_VOLUME_METRIC_TYPES


class GcnvMetricsAdapter(ProviderAdapter):
    """Acquires GCNV metrics from Cloud Monitoring (volume, pool, tier categories)."""

    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        if action == "testConnection":
            return self._test_connection(connector_config, credential)
        if action == "listMetricCategories":
            from .metric_explorer_nodes import gcnv_metric_category_nodes
            return ExplorerResponse(nodes=gcnv_metric_category_nodes())
        return ExplorerResponse(nodes=[])

    def _test_connection(self, config: Dict[str, Any], credential: Dict[str, str]) -> ExplorerResponse:
        project_id = config.get("project_id", "")
        if not project_id:
            return ExplorerResponse(error=ExplorerError(code="MISSING_CONFIG", message="project_id is required"))
        try:
            from google.oauth2 import service_account

            sa_json = resolve_gcp_service_account_json(credential)
            if not sa_json:
                return ExplorerResponse(error=ExplorerError(
                    code="CREDENTIAL_ERROR", message="service account JSON is required in credential"
                ))
            sa_info = json.loads(sa_json)
            creds = service_account.Credentials.from_service_account_info(
                sa_info, scopes=["https://www.googleapis.com/auth/monitoring.read"]
            )
            from googleapiclient.discovery import build
            monitoring = build("monitoring", "v3", credentials=creds)
            monitoring.projects().metricDescriptors().list(
                name=f"projects/{project_id}",
                filter='metric.type = starts_with("netapp.googleapis.com/")',
                pageSize=1,
            ).execute()
            return ExplorerResponse(nodes=[
                ExplorerNode(
                    id="project",
                    label=project_id,
                    type="project",
                    metadata={"provider": "gcnv_metrics"},
                )
            ])
        except json.JSONDecodeError as e:
            return ExplorerResponse(error=ExplorerError(
                code="CREDENTIAL_ERROR", message=f"Invalid service_account_json: {e}"
            ))
        except Exception as e:
            return ExplorerResponse(error=ExplorerError(code="CONNECTION_ERROR", message=str(e)))

    # Maps (metric_type, op_type_label) -> volume_metrics schema column name.
    # `op_type_label` is the value of `metric.labels["type"]` for the perf
    # metrics (operation_count, throughput, average_latency) and ignored for
    # capacity / inode metrics. Latency lands in split `latency_{read,write,other}_us`
    # columns; `normalize_volume_metrics_row` derives `latency_avg_us` at flatten time.
    @staticmethod
    def _field_for_metric(metric_type: str, metric_labels: Dict[str, str]) -> Optional[str]:
        op_type = metric_labels.get("type", "")
        if metric_type == "netapp.googleapis.com/volume/operation_count":
            if op_type == "read":
                return "iops_read"
            if op_type == "write":
                return "iops_write"
            if op_type == "metadata":
                return "iops_other"
            return None  # unlabeled or unknown type label — drop
        if metric_type == "netapp.googleapis.com/volume/throughput":
            if op_type == "read":
                return "throughput_read_bytes"
            if op_type == "write":
                return "throughput_write_bytes"
            if op_type == "metadata":
                return "throughput_other_bytes"
            return None
        if metric_type == "netapp.googleapis.com/volume/average_latency":
            if op_type == "read":
                return "latency_read_us"
            if op_type == "write":
                return "latency_write_us"
            if op_type == "metadata":
                return "latency_other_us"
            return None
        if metric_type == "netapp.googleapis.com/volume/bytes_used":
            return "space_used_bytes"
        if metric_type == "netapp.googleapis.com/volume/allocated_bytes":
            return "space_total_bytes"
        if metric_type == "netapp.googleapis.com/volume/snapshot_bytes":
            return "space_snapshot_bytes"
        if metric_type == "netapp.googleapis.com/volume/inode_used":
            return "inode_used"
        if metric_type == "netapp.googleapis.com/volume/inode_limit":
            return "inode_limit"
        return None

    @staticmethod
    def _field_for_tier_metric(
        metric_type: str,
        metric_labels: Dict[str, str],
    ) -> Optional[tuple[str, str]]:
        """Return (schema_column, tier_name) for volume_tier_metrics rows."""
        if metric_type == "netapp.googleapis.com/volume/auto_tiering/cold_tier_read_byte_count":
            return ("tier_read_bytes", "cold")
        if metric_type == "netapp.googleapis.com/volume/auto_tiering/cold_tier_write_byte_count":
            return ("tier_write_bytes", "cold")
        if metric_type == "netapp.googleapis.com/volume/auto_tiering/tiered_bytes":
            tier_name = _normalize_gcnv_tier_label(metric_labels.get("tier", ""))
            if not tier_name:
                return None
            return ("tier_footprint_bytes", tier_name)
        return None

    @staticmethod
    def _field_for_pool_metric(
        metric_type: str,
        metric_labels: Dict[str, str],
    ) -> Optional[str]:
        """Return pool_metrics schema column for a storage_pool metric type."""
        if metric_type == "netapp.googleapis.com/storage_pool/capacity":
            return "capacity_bytes"
        if metric_type == "netapp.googleapis.com/storage_pool/allocated":
            return "allocated_bytes"
        if metric_type == "netapp.googleapis.com/storage_pool/auto_tiering/cold_tier_read_byte_count":
            return "tier_read_bytes"
        if metric_type == "netapp.googleapis.com/storage_pool/auto_tiering/cold_tier_write_byte_count":
            return "tier_write_bytes"
        if metric_type == "netapp.googleapis.com/storage_pool/auto_tiering/tiered_bytes":
            tier_name = _normalize_gcnv_tier_label(metric_labels.get("tier", ""))
            if tier_name != "cold":
                return None
            return "tier_cold_bytes"
        if metric_type == "netapp.googleapis.com/storage_pool/replication_status":
            return "replication_sync_status"
        return None

    async def acquire(
        self,
        connection_info: Dict[str, Any],
        watermark: Optional[str],
        output_path: str,
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> Dict[str, Any]:
        project_id = connection_info.get("project_id", "")
        credentials_path = connection_info.get("credentials_path", "")
        sa_json = resolve_gcp_service_account_json(connection_info)
        region = connection_info.get("region", "")

        if not project_id:
            raise ValueError("GCNV connection requires project_id")

        resource_selector = connection_info.get("resourceSelector") or []
        categories = (
            {r["category"] for r in resource_selector if "category" in r}
            if resource_selector
            else None
        )
        write_volumes = categories is None or "volume_metrics" in categories
        write_pools = categories is None or "pool_metrics" in categories
        write_tiers = categories is None or "volume_tier_metrics" in categories

        # Determine time range. Cloud Monitoring retains netapp metrics for
        # ~6 weeks and samples every 5 minutes, so:
        #   - fresh backfill (no watermark) = 30 days back
        #   - incremental run = since-watermark, BUT clamped to a minimum
        #     window of 2x the sample period (10 min). Without this clamp a
        #     watermark closer than 5min to `now` produces a sub-sample-period
        #     window which deterministically returns 0 perf points and at
        #     most 1 capacity point. This was observed in production: a
        #     prior partial run had advanced the watermark to ~85s ago, so
        #     every retry queried a 85-second window.
        now = datetime.now(timezone.utc)
        sample_period = timedelta(minutes=5)
        min_window = sample_period * 2  # 10 min
        if watermark:
            try:
                start_time = datetime.fromisoformat(watermark.replace("Z", "+00:00"))
                lookback_source = "watermark"
            except ValueError:
                start_time = now - timedelta(days=30)
                lookback_source = f"invalid-watermark({watermark!r})-fallback-30d"
        else:
            start_time = now - timedelta(days=30)
            lookback_source = "no-watermark-backfill-30d"

        if (now - start_time) < min_window:
            new_start = now - min_window
            logger.info(
                "[GcnvMetrics] Window (%s -> %s) is shorter than 2x sample period "
                "(%s); extending start back to %s to guarantee at least one sample.",
                start_time.isoformat(), now.isoformat(), min_window, new_start.isoformat(),
            )
            start_time = new_start
            lookback_source = lookback_source + "+min-window-clamped"

        # Build explicit credentials. Order of precedence:
        #   1. inline service_account_json (what the credential service returns)
        #   2. credentials_path (legacy / out-of-band file mount)
        #   3. ADC via GOOGLE_APPLICATION_CREDENTIALS / metadata server
        # Whichever source we use, we MUST log it — silent ADC fallback is the
        # #1 reason this activity returned 0 rows with no useful logs.
        try:
            creds, creds_source = _build_acquire_credentials(
                sa_json, credentials_path, _GCNV_ACQUIRE_SCOPES
            )
        except Exception:
            logger.exception("[GcnvMetrics] Failed to build GCP credentials")
            raise

        logger.info(
            "[GcnvMetrics] acquire start: project_id=%s region=%r watermark=%r "
            "start=%s end=%s lookback_source=%s creds=%s",
            project_id,
            region,
            watermark,
            start_time.isoformat(),
            now.isoformat(),
            lookback_source,
            creds_source,
        )

        _safe_heartbeat(heartbeat, "gcnv:volumes_inventory")
        volume_inventory: Dict[str, Dict[str, Any]] = {}
        pool_inventory: Dict[str, Dict[str, Any]] = {}
        if write_volumes or write_tiers:
            volume_inventory = _fetch_volumes_inventory(project_id, region, creds)
        if write_pools:
            _safe_heartbeat(heartbeat, "gcnv:pools_inventory")
            pool_inventory = _fetch_pools_inventory(project_id, region, creds)

        volume_rows: List[Dict[str, Any]] = []
        tier_rows: List[Dict[str, Any]] = []
        pool_rows: List[Dict[str, Any]] = []

        if write_volumes:
            volume_rows = await self._fetch_volume_metrics(
                project_id,
                start_time,
                now,
                region,
                credentials=creds,
                volume_inventory=volume_inventory,
                heartbeat=heartbeat,
            )
        if write_tiers:
            tier_rows = await self._fetch_tier_metrics(
                project_id,
                start_time,
                now,
                region,
                credentials=creds,
                heartbeat=heartbeat,
            )
        if write_pools:
            pool_rows = await self._fetch_pool_metrics(
                project_id,
                start_time,
                now,
                region,
                credentials=creds,
                pool_inventory=pool_inventory,
                heartbeat=heartbeat,
            )

        os.makedirs(output_path, exist_ok=True)

        if write_volumes:
            vol_path = os.path.join(output_path, "volume_metrics.parquet")
            if volume_rows:
                pq.write_table(
                    pa.Table.from_pylist(volume_rows, schema=VOLUME_METRICS_SCHEMA),
                    vol_path,
                )
                logger.info("[GcnvMetrics] Wrote %d volume metrics rows to %s", len(volume_rows), vol_path)
            else:
                write_empty_volume_metrics_parquet(output_path)

        if write_tiers:
            tier_path = os.path.join(output_path, "volume_tier_metrics.parquet")
            if tier_rows:
                pq.write_table(
                    pa.Table.from_pylist(tier_rows, schema=VOLUME_TIER_METRICS_SCHEMA),
                    tier_path,
                )
                logger.info("[GcnvMetrics] Wrote %d volume tier metrics rows to %s", len(tier_rows), tier_path)
            else:
                write_empty_category_parquet(output_path, "volume_tier_metrics")

        if write_pools:
            pool_path = os.path.join(output_path, "pool_metrics.parquet")
            if pool_rows:
                pq.write_table(
                    pa.Table.from_pylist(pool_rows, schema=POOL_METRICS_SCHEMA),
                    pool_path,
                )
                logger.info("[GcnvMetrics] Wrote %d pool metrics rows to %s", len(pool_rows), pool_path)
            else:
                write_empty_category_parquet(output_path, "pool_metrics")

        time_series_rows = volume_rows + tier_rows + pool_rows
        timestamps = [r["timestamp"] for r in time_series_rows if r.get("timestamp")]
        if timestamps:
            max_obs = max(timestamps)
            new_watermark = max_obs.isoformat() if hasattr(max_obs, "isoformat") else str(max_obs)
        else:
            new_watermark = watermark or ""
            logger.info(
                "[GcnvMetrics] 0 time-series rows produced; preserving prior watermark=%r",
                new_watermark,
            )

        total_rows = len(volume_rows) + len(tier_rows) + len(pool_rows)
        return {
            "outputPath": output_path,
            "newWatermarkValue": new_watermark,
            "rowCount": total_rows,
            "volumeMetricsCount": len(volume_rows),
            "volumeTierMetricsCount": len(tier_rows),
            "poolMetricsCount": len(pool_rows),
            "aggregateMetricsCount": 0,
        }

    def _monitoring_client(self, credentials: Any):
        try:
            from google.cloud import monitoring_v3
        except ImportError as e:
            msg = (
                "[GcnvMetrics] google-cloud-monitoring is not installed in this "
                "worker image (import failed: %s). Add `google-cloud-monitoring` "
                "to src/nemo/workers/connector-worker/requirements.txt and rebuild "
                "the connector-worker image." % e
            )
            logger.error(msg)
            raise RuntimeError(msg) from e

        if credentials is not None:
            return monitoring_v3.MetricServiceAsyncClient(credentials=credentials)
        logger.warning(
            "[GcnvMetrics] No explicit credentials provided; falling back to ADC. "
            "If the worker pod has no GCP identity this will fail."
        )
        return monitoring_v3.MetricServiceAsyncClient()

    async def _fetch_volume_metrics(
        self,
        project_id: str,
        start_time: datetime,
        end_time: datetime,
        region: str,
        credentials: Any = None,
        volume_inventory: Optional[Dict[str, Dict[str, Any]]] = None,
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch metrics from Cloud Monitoring API.

        On total failure (every metric type errored OR every metric type
        returned zero series) this raises so the activity surfaces a real
        error rather than silently writing an empty parquet. A 0-row result
        is almost always a config/perm bug, not "the volume was idle".
        """
        from google.api_core.exceptions import GoogleAPIError
        from google.cloud import monitoring_v3
        from google.protobuf.timestamp_pb2 import Timestamp

        client = self._monitoring_client(credentials)
        project_name = f"projects/{project_id}"

        interval = monitoring_v3.TimeInterval()
        start_ts = Timestamp()
        start_ts.FromDatetime(start_time)
        end_ts = Timestamp()
        end_ts.FromDatetime(end_time)
        interval.start_time = start_ts
        interval.end_time = end_ts

        # Group data by volume and timestamp.
        volume_data: Dict[str, Dict[str, Dict[str, Any]]] = {}

        # Tally per-metric series + point counts so we can tell exactly which
        # metric types returned data and which did not.
        per_metric_counts: List[Dict[str, Any]] = []
        per_metric_errors: List[str] = []

        metric_types = GCNV_VOLUME_METRIC_TYPES
        total_metric_types = len(metric_types)
        for m_idx, metric_type in enumerate(metric_types, start=1):
            _safe_heartbeat(
                heartbeat,
                f"gcnv:metric_type {m_idx}/{total_metric_types}:{metric_type.split('/')[-1]}",
            )
            # Filter ONLY on metric.type. We do not pin resource.type because
            # GCNV publishes its volume metrics under the metric prefix
            # `netapp.googleapis.com/volume/...`, which is already specific
            # enough — and the resource.type literal differs by version
            # (`netapp.googleapis.com/Volume`). One mistyped resource filter
            # on top of a NotFound on metric.type was the failure mode we just
            # debugged; keep the filter minimal.
            metric_filter = f'metric.type = "{metric_type}"'
            metric_filter += _gcnv_monitoring_location_filter(region)

            logger.info(
                "[GcnvMetrics] list_time_series project=%s filter=%s start=%s end=%s",
                project_name, metric_filter, start_time.isoformat(), end_time.isoformat(),
            )

            ts_count = 0
            point_count = 0
            try:
                request = monitoring_v3.ListTimeSeriesRequest(
                    name=project_name,
                    filter=metric_filter,
                    interval=interval,
                    view=monitoring_v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
                )

                page_count = 0
                async for ts in await client.list_time_series(request=request):
                    page_count += 1
                    ts_count += 1
                    if page_count % 50 == 0:
                        _safe_heartbeat(
                            heartbeat,
                            f"gcnv:metric_type {m_idx}/{total_metric_types} page={page_count}",
                        )

                    res_labels = dict(ts.resource.labels)
                    metric_labels = dict(ts.metric.labels) if hasattr(ts, "metric") else {}

                    # GCNV's `Volume` monitored-resource carries `volume_name`
                    # and `location` labels. We accept several legacy synonyms
                    # because labels have churned across GCNV API revisions.
                    volume_id = (
                        res_labels.get("volume_id")
                        or res_labels.get("name")
                        or res_labels.get("volume_name")
                        or ""
                    )
                    volume_name = res_labels.get("volume_name") or volume_id

                    if not volume_id:
                        logger.warning(
                            "[GcnvMetrics] time series with no identifiable volume label; "
                            "resource_type=%s labels=%s metric=%s — skipping",
                            ts.resource.type, res_labels, metric_type,
                        )
                        continue

                    # Compute the schema field this (metric, op-type) maps to.
                    # For perf metrics we honor the `type` metric-label
                    # (read|write|metadata). Unknown label values are dropped
                    # so they don't pollute row assembly; counted by ts_count above
                    # for visibility but not a hard error.
                    field = self._field_for_metric(metric_type, metric_labels)
                    if field is None:
                        # Drop unknown variants (e.g. unlabeled operation_count)
                        # so they don't pollute totals; counted by ts_count above
                        # for visibility but not a hard error.
                        continue

                    if volume_id not in volume_data:
                        volume_data[volume_id] = {}

                    for point in ts.points:
                        point_count += 1
                        point_time = _monitoring_point_time(point)
                        time_key = point_time.isoformat()

                        if time_key not in volume_data[volume_id]:
                            inv = lookup_volume_inventory(
                                volume_inventory or {},
                                volume_id,
                                metric_labels.get("volume_name") or volume_name,
                            )
                            volume_data[volume_id][time_key] = {
                                "timestamp": point_time,
                                "volume_id": volume_id,
                                "volume_name": (inv or {}).get("volume_name") or volume_name,
                                "account_id": project_id,
                                "pool_id": (inv or {}).get("pool_id")
                                or metric_labels.get("storage_pool")
                                or res_labels.get("storage_pool"),
                                "service_level": (inv or {}).get("service_level")
                                or metric_labels.get("service_level")
                                or res_labels.get("service_level"),
                            }

                        value = _monitoring_point_value(point)

                        # average_latency is reported in milliseconds; the
                        # parquet schema column is microseconds. Convert at
                        # the source so downstream consumers don't need to know.
                        # Read, write, and metadata latency land in separate
                        # columns (`latency_*_us`); normalize_volume_metrics_row
                        # derives `latency_avg_us` during row flattening
                        # (a single column at parse time would silently overwrite).
                        if field in ("latency_read_us", "latency_write_us", "latency_other_us"):
                            value *= 1000.0

                        if field in ("space_used_bytes", "space_total_bytes", "space_snapshot_bytes", "inode_used", "inode_limit"):
                            volume_data[volume_id][time_key][field] = int(value)
                        else:
                            volume_data[volume_id][time_key][field] = value

            except GoogleAPIError as e:
                # Surface the canonical GCP error reason so we know whether
                # it's auth, perms, quota, or wrong-project.
                logger.exception(
                    "[GcnvMetrics] GoogleAPIError fetching %s: type=%s message=%s",
                    metric_type, type(e).__name__, e,
                )
                per_metric_errors.append(f"{metric_type}: {type(e).__name__}: {e}")
            except Exception as e:
                logger.exception(
                    "[GcnvMetrics] Unexpected error fetching %s: %s",
                    metric_type, e,
                )
                per_metric_errors.append(f"{metric_type}: {type(e).__name__}: {e}")

            per_metric_counts.append(
                {"metric": metric_type, "time_series": ts_count, "points": point_count}
            )
            logger.info(
                "[GcnvMetrics] %s -> time_series=%d points=%d",
                metric_type, ts_count, point_count,
            )

        # Summary log — makes 0-row debugging much easier.
        total_series = sum(c["time_series"] for c in per_metric_counts)
        total_points = sum(c["points"] for c in per_metric_counts)
        logger.info(
            "[GcnvMetrics] fetch summary: total_series=%d total_points=%d "
            "metrics_with_data=%d/%d errors=%d",
            total_series,
            total_points,
            sum(1 for c in per_metric_counts if c["time_series"] > 0),
            len(per_metric_counts),
            len(per_metric_errors),
        )

        # If EVERY metric errored, propagate so the activity fails loudly
        # rather than writing an empty parquet and claiming success.
        if per_metric_errors and len(per_metric_errors) == len(metric_types):
            raise RuntimeError(
                "[GcnvMetrics] All volume metric types failed; first error: "
                + per_metric_errors[0]
            )

        if total_series == 0 and not per_metric_errors:
            raise RuntimeError(
                "[GcnvMetrics] Cloud Monitoring returned 0 volume time series for project "
                f"{project_id!r} between {start_time.isoformat()} and "
                f"{end_time.isoformat()} (region filter={region!r}). "
                "Verify: (a) project_id is correct and has GCNV volumes, "
                "(b) the service account has roles/monitoring.viewer on the project, "
                "(c) the region in the connector matches the volume's location label, "
                "(d) the volumes have been emitting metrics in the time window."
            )

        rows = []
        # Convert to flat rows. Field keys are schema-aligned because we mapped
        # them in `_field_for_metric` at parse time. normalize_volume_metrics_row
        # fills any missing v2 columns, derives iops/throughput totals, space and
        # inode percentages, and latency_avg_us from the split latency columns.
        for volume_id, time_points in volume_data.items():
            for time_key, data in time_points.items():
                rows.append(normalize_volume_metrics_row({
                    "timestamp": data["timestamp"],
                    "source_type": "gcnv",
                    "account_id": data.get("account_id", project_id),
                    "cluster_id": project_id,
                    "pool_id": data.get("pool_id"),
                    "volume_id": volume_id,
                    "volume_name": data.get("volume_name", ""),
                    "svm_name": None,
                    "service_level": data.get("service_level"),
                    "iops_read": data.get("iops_read"),
                    "iops_write": data.get("iops_write"),
                    "iops_other": data.get("iops_other"),
                    "throughput_read_bytes": data.get("throughput_read_bytes"),
                    "throughput_write_bytes": data.get("throughput_write_bytes"),
                    "throughput_other_bytes": data.get("throughput_other_bytes"),
                    "latency_read_us": data.get("latency_read_us"),
                    "latency_write_us": data.get("latency_write_us"),
                    "latency_other_us": data.get("latency_other_us"),
                    "space_used_bytes": data.get("space_used_bytes"),
                    "space_total_bytes": data.get("space_total_bytes"),
                    "space_snapshot_bytes": data.get("space_snapshot_bytes"),
                    "inode_used": data.get("inode_used"),
                    "inode_limit": data.get("inode_limit"),
                }))

        logger.info(
            "[GcnvMetrics] flattened %d unique volumes into %d rows",
            len(volume_data), len(rows),
        )
        return rows

    async def _fetch_tier_metrics(
        self,
        project_id: str,
        start_time: datetime,
        end_time: datetime,
        region: str,
        credentials: Any = None,
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch volume-scoped auto-tiering metrics (may be empty on Flex Unified)."""
        from google.api_core.exceptions import GoogleAPIError
        from google.cloud import monitoring_v3
        from google.protobuf.timestamp_pb2 import Timestamp

        client = self._monitoring_client(credentials)
        project_name = f"projects/{project_id}"
        interval = monitoring_v3.TimeInterval()
        start_ts = Timestamp()
        start_ts.FromDatetime(start_time)
        end_ts = Timestamp()
        end_ts.FromDatetime(end_time)
        interval.start_time = start_ts
        interval.end_time = end_ts

        # volume_id -> time_key -> tier_name -> partial row
        tier_data: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]] = {}
        per_metric_errors: List[str] = []
        metric_types = GCNV_TIER_METRIC_TYPES

        for m_idx, metric_type in enumerate(metric_types, start=1):
            _safe_heartbeat(
                heartbeat,
                f"gcnv:tier {m_idx}/{len(metric_types)}:{metric_type.split('/')[-1]}",
            )
            metric_filter = f'metric.type = "{metric_type}"'
            metric_filter += _gcnv_monitoring_location_filter(region)

            try:
                request = monitoring_v3.ListTimeSeriesRequest(
                    name=project_name,
                    filter=metric_filter,
                    interval=interval,
                    view=monitoring_v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
                )
                async for ts in await client.list_time_series(request=request):
                    res_labels = dict(ts.resource.labels)
                    metric_labels = dict(ts.metric.labels) if hasattr(ts, "metric") else {}
                    mapped = self._field_for_tier_metric(metric_type, metric_labels)
                    if mapped is None:
                        continue
                    field, tier_name = mapped

                    volume_id = (
                        res_labels.get("volume_id")
                        or res_labels.get("name")
                        or res_labels.get("volume_name")
                        or metric_labels.get("volume_name")
                        or ""
                    )
                    if not volume_id:
                        continue

                    if volume_id not in tier_data:
                        tier_data[volume_id] = {}
                    for point in ts.points:
                        point_time = _monitoring_point_time(point)
                        time_key = point_time.isoformat()
                        if time_key not in tier_data[volume_id]:
                            tier_data[volume_id][time_key] = {}
                        if tier_name not in tier_data[volume_id][time_key]:
                            tier_data[volume_id][time_key][tier_name] = {
                                "timestamp": point_time,
                            }
                        tier_data[volume_id][time_key][tier_name][field] = int(
                            _monitoring_point_value(point)
                        )
            except GoogleAPIError as e:
                logger.exception("[GcnvMetrics] tier GoogleAPIError fetching %s: %s", metric_type, e)
                per_metric_errors.append(f"{metric_type}: {type(e).__name__}: {e}")
            except Exception as e:
                logger.exception("[GcnvMetrics] tier error fetching %s: %s", metric_type, e)
                per_metric_errors.append(f"{metric_type}: {type(e).__name__}: {e}")

        if per_metric_errors and len(per_metric_errors) == len(metric_types):
            raise RuntimeError(
                "[GcnvMetrics] All volume tier metric types failed; first error: "
                + per_metric_errors[0]
            )

        rows: List[Dict[str, Any]] = []
        for volume_id, time_points in tier_data.items():
            for time_key, tiers in time_points.items():
                for tier_name, data in tiers.items():
                    rows.append({
                        "timestamp": data["timestamp"],
                        "source_type": "gcnv",
                        "cluster_id": project_id,
                        "volume_id": volume_id,
                        "tier_name": tier_name,
                        "tier_read_bytes": data.get("tier_read_bytes"),
                        "tier_write_bytes": data.get("tier_write_bytes"),
                        "tier_footprint_bytes": data.get("tier_footprint_bytes"),
                    })

        logger.info("[GcnvMetrics] flattened %d volume tier rows", len(rows))
        return rows

    async def _fetch_pool_metrics(
        self,
        project_id: str,
        start_time: datetime,
        end_time: datetime,
        region: str,
        credentials: Any = None,
        pool_inventory: Optional[Dict[str, Dict[str, Any]]] = None,
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch storage pool metrics from Cloud Monitoring."""
        from google.api_core.exceptions import GoogleAPIError
        from google.cloud import monitoring_v3
        from google.protobuf.timestamp_pb2 import Timestamp

        client = self._monitoring_client(credentials)
        project_name = f"projects/{project_id}"
        interval = monitoring_v3.TimeInterval()
        start_ts = Timestamp()
        start_ts.FromDatetime(start_time)
        end_ts = Timestamp()
        end_ts.FromDatetime(end_time)
        interval.start_time = start_ts
        interval.end_time = end_ts

        pool_data: Dict[str, Dict[str, Dict[str, Any]]] = {}
        per_metric_counts: List[Dict[str, Any]] = []
        per_metric_errors: List[str] = []
        metric_types = GCNV_POOL_METRIC_TYPES

        for m_idx, metric_type in enumerate(metric_types, start=1):
            _safe_heartbeat(
                heartbeat,
                f"gcnv:pool {m_idx}/{len(metric_types)}:{metric_type.split('/')[-1]}",
            )
            metric_filter = f'metric.type = "{metric_type}"'
            metric_filter += _gcnv_monitoring_location_filter(region)
            ts_count = 0
            point_count = 0

            try:
                request = monitoring_v3.ListTimeSeriesRequest(
                    name=project_name,
                    filter=metric_filter,
                    interval=interval,
                    view=monitoring_v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
                )
                async for ts in await client.list_time_series(request=request):
                    ts_count += 1
                    res_labels = dict(ts.resource.labels)
                    metric_labels = dict(ts.metric.labels) if hasattr(ts, "metric") else {}
                    field = self._field_for_pool_metric(metric_type, metric_labels)
                    if field is None:
                        continue

                    pool_id = _pool_id_from_labels(res_labels, metric_labels)
                    if not pool_id:
                        logger.warning(
                            "[GcnvMetrics] pool time series with no pool id; labels=%s metric=%s",
                            res_labels,
                            metric_type,
                        )
                        continue

                    if pool_id not in pool_data:
                        pool_data[pool_id] = {}

                    for point in ts.points:
                        point_count += 1
                        point_time = _monitoring_point_time(point)
                        time_key = point_time.isoformat()
                        if time_key not in pool_data[pool_id]:
                            inv = lookup_pool_inventory(pool_inventory or {}, pool_id)
                            pool_data[pool_id][time_key] = {
                                "timestamp": point_time,
                                "pool_id": pool_id,
                                "pool_name": (inv or {}).get("pool_name") or pool_id,
                                "service_level": (inv or {}).get("service_level")
                                or metric_labels.get("service_level")
                                or res_labels.get("service_level"),
                            }
                        value = int(_monitoring_point_value(point))
                        pool_data[pool_id][time_key][field] = value
            except GoogleAPIError as e:
                logger.exception("[GcnvMetrics] pool GoogleAPIError fetching %s: %s", metric_type, e)
                per_metric_errors.append(f"{metric_type}: {type(e).__name__}: {e}")
            except Exception as e:
                logger.exception("[GcnvMetrics] pool error fetching %s: %s", metric_type, e)
                per_metric_errors.append(f"{metric_type}: {type(e).__name__}: {e}")

            per_metric_counts.append(
                {"metric": metric_type, "time_series": ts_count, "points": point_count}
            )

        total_series = sum(c["time_series"] for c in per_metric_counts)
        if per_metric_errors and len(per_metric_errors) == len(metric_types):
            raise RuntimeError(
                "[GcnvMetrics] All pool metric types failed; first error: "
                + per_metric_errors[0]
            )
        if total_series == 0 and not per_metric_errors:
            raise RuntimeError(
                "[GcnvMetrics] Cloud Monitoring returned 0 pool time series for project "
                f"{project_id!r} between {start_time.isoformat()} and "
                f"{end_time.isoformat()} (region filter={region!r})."
            )

        rows: List[Dict[str, Any]] = []
        for pool_id, time_points in pool_data.items():
            for time_key, data in time_points.items():
                rows.append({
                    "timestamp": data["timestamp"],
                    "source_type": "gcnv",
                    "cluster_id": project_id,
                    "pool_id": data.get("pool_id", pool_id),
                    "pool_name": data.get("pool_name", pool_id),
                    "service_level": data.get("service_level"),
                    "capacity_bytes": data.get("capacity_bytes"),
                    "allocated_bytes": data.get("allocated_bytes"),
                    "used_bytes": None,
                    "tier_cold_bytes": data.get("tier_cold_bytes"),
                    "tier_read_bytes": data.get("tier_read_bytes"),
                    "tier_write_bytes": data.get("tier_write_bytes"),
                    "replication_sync_status": data.get("replication_sync_status"),
                })

        logger.info("[GcnvMetrics] flattened %d pool rows", len(rows))
        return rows
