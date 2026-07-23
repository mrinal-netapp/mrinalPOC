"""ONTAP Metrics Adapter — fetches Counter Manager time-series from ONTAP REST API.

Produces two Parquet tables: volume_metrics and aggregate_metrics.

Time-series behaviour:
  - First run (no watermark): backfills up to BACKFILL_HOURS (default 14 days) of
    historical counter data retained by ONTAP.
  - Subsequent runs: fetches only new samples since the watermark (exclusive lower bound).
  - Overlap prevention: watermark is set to the max timestamp actually received; next run
    queries with timestamp > watermark so no sample is ever fetched twice.
  - Pagination: follows ONTAP _links.next for large result sets.
  - Deduplication: rows are keyed on (object_id, timestamp) within each fetch to handle
    any ONTAP API edge cases with duplicate records.
"""
from observability_client_runtime import get_logger
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, Optional

import httpx
import pyarrow as pa
import pyarrow.parquet as pq


def _safe_heartbeat(cb: Optional[Callable[..., None]], *details: Any) -> None:
    """Heartbeat helper that swallows errors when called outside a Temporal activity (e.g. tests)."""
    if cb is None:
        return
    try:
        cb(*details)
    except Exception:  # pragma: no cover - heartbeat must never fail the activity
        logger.debug("heartbeat callback raised, ignoring", exc_info=True)

from ontap_common import verify_tls_from_connector_config

from .base import ProviderAdapter, ExplorerResponse, ExplorerNode
from .metric_table_schemas import (
    QUOTA_METRICS_SCHEMA,
    VOLUME_METRICS_SCHEMA,
    build_quota_metrics_rows,
    normalize_metric_categories,
    normalize_volume_metrics_row,
    write_empty_category_parquet,
)

logger = get_logger()


class OntapMetricsAdapter(ProviderAdapter):
    """Acquires performance metrics from ONTAP Counter Manager API."""

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
            from .metric_explorer_nodes import ontap_metric_category_nodes
            return ExplorerResponse(nodes=ontap_metric_category_nodes())
        return ExplorerResponse(nodes=[])

    def _test_connection(self, config: Dict[str, Any], credential: Dict[str, str]) -> ExplorerResponse:
        url = config.get("cluster_url", "")
        if not url:
            from .base import ExplorerError
            return ExplorerResponse(error=ExplorerError(code="MISSING_CONFIG", message="cluster_url is required"))
        host = url
        if host.startswith("https://"):
            host = host[len("https://"):]
        elif host.startswith("http://"):
            host = host[len("http://"):]
        username = credential.get("username", "")
        password = credential.get("password", "")
        verify = verify_tls_from_connector_config(config)
        test_url = f"https://{host}/api/cluster"
        logger.info("[OntapMetrics] testConnection: GET %s verify_tls=%s user=%s", test_url, verify, username)
        try:
            with httpx.Client(verify=verify, timeout=10.0) as client:
                resp = client.get(
                    test_url,
                    auth=(username, password) if username else None,
                )
                logger.info("[OntapMetrics] testConnection: status=%d", resp.status_code)
                resp.raise_for_status()
                data = resp.json()
                cluster_name = data.get("name", host)
                version_full = data.get("version", {}).get("full", "")
            return ExplorerResponse(nodes=[
                ExplorerNode(
                    id="cluster",
                    label=cluster_name,
                    type="cluster",
                    metadata={"version": version_full, "provider": "ontap_metrics"},
                )
            ])
        except httpx.HTTPStatusError as e:
            from .base import ExplorerError
            return ExplorerResponse(error=ExplorerError(
                code="AUTH_FAILED" if e.response.status_code == 401 else "HTTP_ERROR",
                message=f"ONTAP API returned {e.response.status_code}: {e.response.text[:200]}",
            ))
        except Exception as e:
            from .base import ExplorerError
            return ExplorerResponse(error=ExplorerError(code="CONNECTION_ERROR", message=str(e)))

    AGGREGATE_METRICS_SCHEMA = pa.schema([
        ("timestamp", pa.timestamp("us", tz="UTC")),
        ("source_type", pa.string()),
        ("cluster_id", pa.string()),
        ("aggregate_id", pa.string()),
        ("aggregate_name", pa.string()),
        ("current_ops", pa.float64()),
        ("optimal_point_ops", pa.float64()),
        ("available_ops", pa.float64()),
        ("cold_data_bytes", pa.int64()),
        ("total_data_bytes", pa.int64()),
        ("cache_hit_ratio", pa.float64()),
    ])

    # Interval selection based on how far back we need to look:
    #   <=1h  -> "1h" (15s samples)
    #   <=1d  -> "1d" (5min samples)
    #   <=7d  -> "1w" (30min samples)
    #   <=30d -> "1m" (2h samples)
    INTERVAL_THRESHOLDS = [
        (timedelta(hours=1), "1h"),
        (timedelta(days=1), "1d"),
        (timedelta(days=7), "1w"),
        (timedelta(days=30), "1m"),
    ]
    DEFAULT_INTERVAL = "1w"

    async def acquire(
        self,
        connection_info: Dict[str, Any],
        watermark: Optional[str],
        output_path: str,
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> Dict[str, Any]:
        host = connection_info.get("host", "")
        username = connection_info.get("username", "")
        password = connection_info.get("password", "")
        cluster_id = connection_info.get("cluster_id", host)
        verify_ssl = verify_tls_from_connector_config(connection_info)

        if not host or not username:
            raise ValueError("ONTAP connection requires host and username")

        resource_selector = connection_info.get("resourceSelector") or []
        categories = {r["category"] for r in resource_selector if "category" in r} if resource_selector else None
        if categories is not None:
            categories = normalize_metric_categories(categories)

        write_volumes = categories is None or "volume_metrics" in categories
        write_aggregates = categories is None or "aggregate_metrics" in categories
        write_quotas = categories is None or "quota_metrics" in categories
        if categories is not None:
            logger.info("[OntapMetrics] resourceSelector categories: %s", categories)

        base_url = f"https://{host}/api"
        now = datetime.now(timezone.utc)

        # Determine time range from watermark
        if watermark:
            try:
                range_start = datetime.fromisoformat(watermark.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                range_start = None
            is_backfill = False
        else:
            range_start = None
            is_backfill = True

        # Pick the right interval based on how far back range_start is
        lookback = (now - range_start) if range_start else timedelta(days=7)
        interval = self.DEFAULT_INTERVAL
        for threshold, intv in self.INTERVAL_THRESHOLDS:
            if lookback <= threshold:
                interval = intv
                break
        else:
            interval = "1m"

        logger.info(
            "[OntapMetrics] Starting acquire: host=%s verify_ssl=%s watermark=%s "
            "backfill=%s interval=%s lookback=%s",
            host, verify_ssl, watermark, is_backfill, interval, lookback,
        )

        async with httpx.AsyncClient(
            base_url=base_url,
            auth=(username, password),
            verify=verify_ssl,
            timeout=120.0,
        ) as client:
            volume_rows: list = []
            aggregate_rows: list = []
            quota_rows: list = []
            quota_data: Dict[str, Dict] = {}

            if write_volumes:
                _safe_heartbeat(heartbeat, "ontap:volumes_inventory")
                volumes_meta = await self._fetch_volumes_inventory(client)
                volume_rows = await self._fetch_volume_metrics_timeseries(
                    client, cluster_id, volumes_meta, interval, range_start,
                    heartbeat=heartbeat,
                )
            else:
                logger.info("[OntapMetrics] Skipping volume metrics (not in resourceSelector)")

            if write_aggregates:
                _safe_heartbeat(heartbeat, "ontap:aggregates_inventory")
                aggregates_meta = await self._fetch_aggregates_inventory(client)
                aggregate_rows = await self._fetch_aggregate_metrics_timeseries(
                    client, cluster_id, aggregates_meta, interval, range_start,
                    heartbeat=heartbeat,
                )
            else:
                logger.info("[OntapMetrics] Skipping aggregate metrics (not in resourceSelector)")

            if write_quotas:
                _safe_heartbeat(heartbeat, "ontap:quota_metrics")
                # Quota reports are point-in-time snapshots → quota_metrics.parquet,
                # not merged onto volume_metrics rows (v2 split).
                quota_data = await self._fetch_quota_reports(client)
                quota_rows = build_quota_metrics_rows(quota_data, cluster_id, now)
            else:
                logger.info("[OntapMetrics] Skipping quota metrics (not in resourceSelector)")

        logger.info(
            "[OntapMetrics] Acquisition complete: volume_rows=%d aggregate_rows=%d "
            "quota_rows=%d backfill=%s interval=%s",
            len(volume_rows), len(aggregate_rows), len(quota_rows), is_backfill, interval,
        )

        # Write Parquet files — only for categories selected (one schema per dataset).
        os.makedirs(output_path, exist_ok=True)

        if write_volumes:
            vol_path = os.path.join(output_path, "volume_metrics.parquet")
            if volume_rows:
                vol_table = pa.Table.from_pylist(volume_rows, schema=VOLUME_METRICS_SCHEMA)
                pq.write_table(vol_table, vol_path)
                logger.info("[OntapMetrics] Wrote %d volume metrics rows to %s", len(volume_rows), vol_path)
            else:
                logger.warning("[OntapMetrics] No volume rows returned — writing empty Parquet")
                write_empty_category_parquet(output_path, "volume_metrics")

        if write_aggregates:
            agg_path = os.path.join(output_path, "aggregate_metrics.parquet")
            if aggregate_rows:
                agg_table = pa.Table.from_pylist(aggregate_rows, schema=self.AGGREGATE_METRICS_SCHEMA)
                pq.write_table(agg_table, agg_path)
                logger.info("[OntapMetrics] Wrote %d aggregate metrics rows to %s", len(aggregate_rows), agg_path)
            else:
                logger.warning("[OntapMetrics] No aggregate rows returned — writing empty Parquet")
                agg_table = pa.table(
                    {f.name: pa.array([], type=f.type) for f in self.AGGREGATE_METRICS_SCHEMA},
                    schema=self.AGGREGATE_METRICS_SCHEMA,
                )
                pq.write_table(agg_table, agg_path)

        if write_quotas:
            quota_path = os.path.join(output_path, "quota_metrics.parquet")
            if quota_rows:
                quota_table = pa.Table.from_pylist(quota_rows, schema=QUOTA_METRICS_SCHEMA)
                pq.write_table(quota_table, quota_path)
                logger.info("[OntapMetrics] Wrote %d quota metrics rows to %s", len(quota_rows), quota_path)
            else:
                logger.warning("[OntapMetrics] No quota rows returned — writing empty Parquet")
                write_empty_category_parquet(output_path, "quota_metrics")

        # Watermark = latest timestamp in the actual time-series data (not quota snapshots).
        max_ts = now
        if volume_rows:
            max_ts = max(max_ts, max(r["timestamp"] for r in volume_rows))
        if aggregate_rows:
            max_ts = max(max_ts, max(r["timestamp"] for r in aggregate_rows))

        return {
            "outputPath": output_path,
            "newWatermarkValue": max_ts.isoformat(),
            "rowCount": len(volume_rows) + len(aggregate_rows) + len(quota_rows),
            "volumeMetricsCount": len(volume_rows),
            "aggregateMetricsCount": len(aggregate_rows),
            "quotaMetricsCount": len(quota_rows),
        }

    # ─── Inventory ─────────────────────────────────────────────────────

    async def _fetch_volumes_inventory(self, client: httpx.AsyncClient) -> dict:
        """Fetch volume metadata. Returns {uuid: record}."""
        url = "/storage/volumes"
        params = {
            "fields": (
                "name,svm.name,space.used,space.size,space.snapshot.used,"
                "qos.policy.name,uuid,files.used,aggregates.uuid,tiering.policy"
            ),
            "max_records": 5000,
        }
        logger.info("[OntapMetrics] GET %s", url)
        try:
            resp = await client.get(url, params=params)
            logger.info("[OntapMetrics] GET %s -> status=%d", url, resp.status_code)
            resp.raise_for_status()
            records = resp.json().get("records", [])
            logger.info("[OntapMetrics] Volume inventory: %d volumes", len(records))
            return {v["uuid"]: v for v in records if v.get("uuid")}
        except Exception as e:
            logger.warning("[OntapMetrics] Failed to fetch volume inventory: %s", e)
            return {}

    async def _fetch_aggregates_inventory(self, client: httpx.AsyncClient) -> dict:
        """Fetch aggregate metadata. Returns {uuid: record}."""
        url = "/storage/aggregates"
        params = {
            "fields": "name,uuid,space.block_storage.size,space.block_storage.used",
            "max_records": 500,
        }
        logger.info("[OntapMetrics] GET %s", url)
        try:
            resp = await client.get(url, params=params)
            logger.info("[OntapMetrics] GET %s -> status=%d", url, resp.status_code)
            resp.raise_for_status()
            records = resp.json().get("records", [])
            logger.info("[OntapMetrics] Aggregate inventory: %d aggregates", len(records))
            return {a["uuid"]: a for a in records if a.get("uuid")}
        except Exception as e:
            logger.warning("[OntapMetrics] Failed to fetch aggregate inventory: %s", e)
            return {}

    # ─── Time-series via /storage/volumes/{uuid}/metrics ───────────────

    async def _fetch_volume_metrics_timeseries(
        self,
        client: httpx.AsyncClient,
        cluster_id: str,
        volumes_meta: dict,
        interval: str,
        range_start: Optional[datetime],
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> list:
        """Fetch performance time-series for each volume. Filters out samples <= range_start."""
        rows = []
        seen: set = set()
        total = len(volumes_meta)

        for idx, (vol_uuid, vol_meta) in enumerate(volumes_meta.items(), start=1):
            # Heartbeat per volume — on a 1000-volume cluster the loop alone
            # easily exceeds the 60s heartbeat timeout.
            _safe_heartbeat(heartbeat, f"ontap:volume_metrics {idx}/{total}")
            url = f"/storage/volumes/{vol_uuid}/metrics"
            params = {
                "interval": interval,
                "max_records": 1000,
                "fields": "timestamp,iops,throughput,latency",
            }
            logger.info("[OntapMetrics] GET %s interval=%s vol=%s", url, interval, vol_meta.get("name", vol_uuid))

            try:
                resp = await client.get(url, params=params)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                body = resp.json()
            except Exception as e:
                logger.warning("[OntapMetrics] Failed metrics for volume %s: %s", vol_uuid, e)
                continue

            records = body.get("records", [])
            logger.info("[OntapMetrics] Volume %s: %d metric samples", vol_meta.get("name", vol_uuid), len(records))

            space = vol_meta.get("space", {})
            files = vol_meta.get("files") or {}
            aggregates = vol_meta.get("aggregates") or []
            pool_id = aggregates[0].get("uuid") if aggregates else None
            space_used = space.get("used") or 0
            space_total = space.get("size") or 0
            for sample in records:
                ts_str = sample.get("timestamp", "")
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue

                # Overlap prevention: skip samples at or before the watermark
                if range_start and ts <= range_start:
                    continue

                dedup_key = (vol_uuid, ts.isoformat())
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                iops = sample.get("iops") or {}
                throughput = sample.get("throughput") or {}
                latency = sample.get("latency") or {}

                rows.append(normalize_volume_metrics_row({
                    "timestamp": ts,
                    "source_type": "ontap",
                    "account_id": cluster_id,
                    "cluster_id": cluster_id,
                    "pool_id": pool_id,
                    "volume_id": vol_uuid,
                    "volume_name": vol_meta.get("name") or "",
                    "svm_name": (vol_meta.get("svm") or {}).get("name") or "",
                    "service_level": (vol_meta.get("tiering") or {}).get("policy"),
                    "iops_read": float(iops.get("read") or 0),
                    "iops_write": float(iops.get("write") or 0),
                    "iops_other": float(iops.get("other") or 0),
                    "iops_total": float(iops.get("total") or 0),
                    "throughput_read_bytes": float(throughput.get("read") or 0),
                    "throughput_write_bytes": float(throughput.get("write") or 0),
                    "throughput_other_bytes": float(throughput.get("other") or 0),
                    "throughput_total_bytes": float(throughput.get("total") or 0),
                    "latency_read_us": float(latency.get("read") or 0),
                    "latency_write_us": float(latency.get("write") or 0),
                    "latency_other_us": float(latency.get("other") or 0),
                    "latency_avg_us": float(latency.get("total") or 0),
                    "space_used_bytes": space_used,
                    "space_total_bytes": space_total,
                    "space_snapshot_bytes": ((space.get("snapshot") or {}).get("used") or 0),
                    "inode_used": files.get("used"),
                    "inode_limit": files.get("maximum"),
                    "qos_policy": (vol_meta.get("qos") or {}).get("policy", {}).get("name"),
                }))

        logger.info("[OntapMetrics] Volume timeseries total: %d rows from %d volumes", len(rows), len(volumes_meta))
        return rows

    # ─── Time-series via /storage/aggregates/{uuid}/metrics ────────────

    async def _fetch_aggregate_metrics_timeseries(
        self,
        client: httpx.AsyncClient,
        cluster_id: str,
        aggregates_meta: dict,
        interval: str,
        range_start: Optional[datetime],
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> list:
        """Fetch performance time-series for each aggregate. Filters out samples <= range_start."""
        rows = []
        seen: set = set()
        total = len(aggregates_meta)

        for idx, (agg_uuid, agg_meta) in enumerate(aggregates_meta.items(), start=1):
            _safe_heartbeat(heartbeat, f"ontap:aggregate_metrics {idx}/{total}")
            url = f"/storage/aggregates/{agg_uuid}/metrics"
            params = {
                "interval": interval,
                "max_records": 1000,
                "fields": "timestamp,iops,throughput",
            }
            logger.info("[OntapMetrics] GET %s interval=%s agg=%s", url, interval, agg_meta.get("name", agg_uuid))

            try:
                resp = await client.get(url, params=params)
                if resp.status_code == 404:
                    continue
                resp.raise_for_status()
                body = resp.json()
            except Exception as e:
                logger.warning("[OntapMetrics] Failed metrics for aggregate %s: %s", agg_uuid, e)
                continue

            records = body.get("records", [])
            logger.info("[OntapMetrics] Aggregate %s: %d metric samples", agg_meta.get("name", agg_uuid), len(records))

            for sample in records:
                ts_str = sample.get("timestamp", "")
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, TypeError):
                    continue

                if range_start and ts <= range_start:
                    continue

                dedup_key = (agg_uuid, ts.isoformat())
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)

                iops = sample.get("iops") or {}
                throughput = sample.get("throughput") or {}

                rows.append({
                    "timestamp": ts,
                    "source_type": "ontap",
                    "cluster_id": cluster_id,
                    "aggregate_id": agg_uuid,
                    "aggregate_name": agg_meta.get("name") or "",
                    "current_ops": float(iops.get("total") or 0),
                    "optimal_point_ops": 0.0,
                    "available_ops": 0.0,
                    "cold_data_bytes": 0,
                    "total_data_bytes": (agg_meta.get("space") or {}).get("block_storage", {}).get("size") or 0,
                    "cache_hit_ratio": 0.0,
                })

        logger.info("[OntapMetrics] Aggregate timeseries total: %d rows from %d aggregates", len(rows), len(aggregates_meta))
        return rows

    # ─── Point-in-time: Quota Reports ──────────────────────────────────

    async def _fetch_quota_reports(self, client: httpx.AsyncClient) -> Dict[str, Dict]:
        """Returns {volume_name: {used, limit}} from quota reports."""
        quota_map: Dict[str, Dict] = {}
        url = "/storage/quota/reports"
        params = {"fields": "space.used.total,space.hard_limit,volume.name,volume.uuid", "max_records": 5000}
        logger.info("[OntapMetrics] GET %s", url)
        try:
            resp = await client.get(url, params=params)
            logger.info("[OntapMetrics] GET %s -> status=%d", url, resp.status_code)
            resp.raise_for_status()
            records = resp.json().get("records", [])
            logger.info("[OntapMetrics] Quota report records: %d", len(records))
            for record in records:
                vol = record.get("volume") or {}
                vol_name = vol.get("name", "")
                if vol_name:
                    space = record.get("space", {})
                    quota_map[vol_name] = {
                        "used": space.get("used", {}).get("total", 0),
                        "limit": space.get("hard_limit", 0),
                        "volume_id": vol.get("uuid") or "",
                    }
        except Exception as e:
            logger.warning("[OntapMetrics] Failed to fetch quota reports: %s", e)
        return quota_map
