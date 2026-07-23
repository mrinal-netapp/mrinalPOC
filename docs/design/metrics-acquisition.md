# Metrics Acquisition Path — Design Document

This document specifies the metrics-as-resource model used by the unified ONTAP, GCP, and Azure cloud connectors, the adapter interface, Parquet schemas, watermark semantics, and the Go workflow integration for ONTAP, GCNV, and ANF metrics acquisition.

> **Update (2026-05):** The standalone `ontap_metrics` / `gcnv_metrics` connectors and the `metrics` connector type have been removed. Metrics are now exposed as a `metric_category` resource branch under the primary `ontap`, `gcp`, and `azure_cloud` connectors, and the workflow-engine routes to `AcquireMetrics` based on the dataset's resource selector containing `{category: ...}` entries — not on connector_type.

## Doc map

- **Motivation** — Why metrics datasets are needed.
- **Architecture** — How metrics acquisition fits into the existing connector framework.
- **Routing: metric_category resource selectors** — How `DataAcquisitionWorkflow` decides metrics vs object-store vs database vs cloud.
- **Adapter interface** — Python activity contract.
- **ONTAP metrics adapter** — Counter Manager API + quotas.
- **GCNV metrics adapter** — Cloud Monitoring API.
- **Parquet schema** — Two-table output (volume_metrics, aggregate_metrics).
- **Watermark semantics** — Per-adapter strategies.
- **Credential resolution** — How adapters authenticate.
- **Error handling** — Retries, partial failures, idempotency.
- **Testing strategy** — Unit, integration, E2E.

---

## Motivation

The Storage Optimization Agent requires historical performance data (IOPS, throughput, latency, space utilization) accumulated over weeks/months to detect trends. This data must be:

1. Collected periodically (every 6 hours)
2. Stored in Iceberg for time-range queries via DuckDB
3. Accumulated incrementally (append-only)

The platform's existing `DataAcquisitionWorkflow` handles `database` and `objectstore` connector types using a proven pattern: adapter fetches delta → Parquet file → Iceberg append. Metrics follow the same pattern but are surfaced as a resource branch under the primary connectors so a single ONTAP or GCP credential pair can drive both data and metrics acquisition.

---

## Architecture

```
DataAcquisitionWorkflow (Go, Temporal)
  │
  ├── if resourceSelector contains {category: ...}  → metrics arm
  │     ├── AcquireMetrics activity (Python, connector-operations queue)
  │     │     ├── OntapMetricsAdapter (when provider == "ontap")
  │     │     ├── GcnvMetricsAdapter  (when provider == "gcp")
  │     │     └── AnfMetricsAdapter   (when provider == "azure_cloud")
  │     ├── DatasetImportWorkflow (register + append to Iceberg)
  │     └── UpdateWatermark activity
  │
  ├── case "database"     → existing
  ├── case "objectstore"  → existing
  ├── case "cloud"        → existing
  └── case "storage"/"api"→ existing
```

The metrics arm runs *before* the connector_type switch and short-circuits it. This keeps a `cloud`-typed GCP connector (with a metric_category selector) from being mis-routed to `AcquireFromGCS`, and keeps a `storage`-typed ONTAP connector from looking for a non-existent objectstore bucket.

---

## Connector Type: `metrics`

### Go Workflow Branch

In `src/nemo/workflow-engine/internal/workflows/data_acquisition.go`, add:

```go
case "metrics":
    // 1. Read current watermark
    var watermark string
    _ = workflow.ExecuteActivity(ctx, "ReadDatasetWatermark", input.DatasetID).Get(ctx, &watermark)

    // 2. Execute metrics acquisition (Python activity on connector-operations queue)
    metricsInput := MetricsAcquisitionInput{
        Provider:       input.Config["provider"].(string), // "ontap_metrics" or "gcnv_metrics"
        ConnectionInfo: input.Config["connectionInfo"],
        Watermark:      watermark,
        OutputPath:     fmt.Sprintf("/tmp/metrics/%s/%s", input.DatasetID, runID),
    }
    var metricsResult MetricsAcquisitionResult
    metricsCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
        TaskQueue:           "connector-operations",
        StartToCloseTimeout: 10 * time.Minute,
        RetryPolicy: &temporal.RetryPolicy{
            MaximumAttempts: 3,
            InitialInterval: 30 * time.Second,
        },
    })
    err := workflow.ExecuteActivity(metricsCtx, "AcquireMetrics", metricsInput).Get(ctx, &metricsResult)
    if err != nil {
        return err
    }

    // 3. Import into Iceberg (reuse existing DatasetImportWorkflow)
    importInput := DatasetImportInput{
        DatasetID: input.DatasetID,
        FilePath:  metricsResult.OutputPath,
    }
    _ = workflow.ExecuteChildWorkflow(ctx, "DatasetImportWorkflow", importInput).Get(ctx, nil)

    // 4. Update watermark
    _ = workflow.ExecuteActivity(ctx, "UpdateDatasetWatermark", input.DatasetID, metricsResult.NewWatermark).Get(ctx, nil)
```

### Types

```go
type MetricsAcquisitionInput struct {
    Provider       string                 `json:"provider"`
    ConnectionInfo map[string]interface{} `json:"connectionInfo"`
    Watermark      string                 `json:"watermark"`
    OutputPath     string                 `json:"outputPath"`
}

type MetricsAcquisitionResult struct {
    OutputPath   string `json:"outputPath"`
    NewWatermark string `json:"newWatermark"`
    RowCount     int    `json:"rowCount"`
}
```

---

## Adapter Interface

Python adapters implement:

```python
class MetricsAdapter(ABC):
    @abstractmethod
    async def acquire(
        self,
        connection_info: dict,
        watermark: str | None,
        output_path: str,
    ) -> MetricsAcquisitionResult:
        """
        Fetch metrics since last watermark, write Parquet file(s) to output_path.
        Returns new watermark value and metadata.
        """
        ...
```

### Result

```python
@dataclass
class MetricsAcquisitionResult:
    output_path: str       # path to the Parquet file written
    new_watermark: str     # ISO timestamp to persist
    row_count: int         # number of rows written
```

### Registry

In `src/nemo/workers/connector-worker/adapters/registry.py`:

```python
METRICS_ADAPTERS = {
    "ontap_metrics": OntapMetricsAdapter,
    "gcnv_metrics": GcnvMetricsAdapter,
}
```

### Activity

The `AcquireMetrics` activity (Temporal Python worker on `connector-operations` queue):

```python
@activity.defn
async def acquire_metrics(input: MetricsAcquisitionInput) -> MetricsAcquisitionResult:
    adapter = METRICS_ADAPTERS[input.provider]()
    return await adapter.acquire(
        connection_info=input.connection_info,
        watermark=input.watermark,
        output_path=input.output_path,
    )
```

---

## ONTAP Metrics Adapter

### API Calls

1. **Counter Manager** — Volume performance:
   ```
   GET /api/cluster/counter/tables/volume/rows?fields=iops.read,iops.write,throughput.read,throughput.write,latency.average
   ```

2. **Counter Manager** — QoS volume:
   ```
   GET /api/cluster/counter/tables/qos_volume/rows?fields=iops.read,iops.write,latency.average
   ```

3. **Counter Manager** — Aggregate headroom:
   ```
   GET /api/cluster/counter/tables/headroom_aggregate/rows?fields=current_ops,optimal_point_ops,available_ops
   ```

4. **Counter Manager** — WAFL hybrid aggregate (tiering):
   ```
   GET /api/cluster/counter/tables/wafl_hya_per_aggregate/rows?fields=read_cache_hit_percent,wc_c2c_hit_percent
   ```

5. **Quota reports**:
   ```
   GET /api/storage/quota/reports?fields=space.used.total,space.hard_limit
   ```

6. **Volume space** (for current space usage):
   ```
   GET /api/storage/volumes?fields=space.used,space.size,space.snapshot.used,name,svm.name,qos.policy.name
   ```

### Watermark Semantics

Counter Manager returns **point-in-time snapshots** (no time-range filter parameter). The watermark represents the last successful acquisition timestamp:

- If watermark is `None` (first run): fetch and store current snapshot
- If watermark is set: fetch current snapshot (always produces new data since timestamp differs)
- Deduplication: `(timestamp_rounded_to_hour, volume_id)` uniqueness in Parquet. Re-runs within the same collection window produce identical data.
- `new_watermark`: ISO timestamp of this acquisition run (`datetime.utcnow().isoformat()`)

### Connection Info

```json
{
  "host": "ontap-cluster.example.com",
  "username": "admin",
  "password": "...",
  "verify_ssl": true,
  "cluster_id": "cluster-01"
}
```

Multi-cluster: one connector instance per cluster. The `cluster_id` is written into every row.

---

## GCNV Metrics Adapter

### API Calls

```
POST https://monitoring.googleapis.com/v3/projects/{project}/timeSeries:query
Filter: metric.type = starts_with("netapp.googleapis.com/volume/")
Interval: startTime = watermark, endTime = now
```

Key metrics:
- `netapp.googleapis.com/volume/read_iops`
- `netapp.googleapis.com/volume/write_iops`
- `netapp.googleapis.com/volume/read_throughput`
- `netapp.googleapis.com/volume/write_throughput`
- `netapp.googleapis.com/volume/average_read_latency`
- `netapp.googleapis.com/volume/average_write_latency`
- `netapp.googleapis.com/volume/used_bytes`
- `netapp.googleapis.com/volume/total_bytes`

### Watermark Semantics

Cloud Monitoring API **supports time-range queries** natively:
- `interval.startTime` = `lastWatermark` (or 30 days ago if first run)
- `interval.endTime` = now
- True incremental: only fetches data points since last run
- `new_watermark` = max timestamp from returned data points

### Connection Info

```json
{
  "project_id": "my-gcp-project",
  "credentials_path": "/secrets/gcp/service-account.json",
  "region": "us-central1"
}
```

---

## ANF Metrics Adapter (Azure NetApp Files)

Connector provider id is **`azure_cloud`** (distinct from LLM provider `azure` / Azure OpenAI).

### API Calls

Acquisition is a two-phase flow: **discover volumes**, then **query Monitor per volume ARM ID**.

#### Phase 1 — Volume discovery

1. **Resource Graph** (preferred): KQL query for `microsoft.netapp/netappaccounts/capacitypools/volumes` filtered by `subscriptionId`, `location` (`default_region`), and optional `resource_group`.
2. **ARM enumeration fallback** (when Resource Graph returns 401/403/404 or empty): walk `netAppAccounts` → `capacityPools` → `volumes` under the subscription, filtered by region and optional resource group.
3. **Service level enrichment**: for each distinct capacity pool, GET the pool resource to read `properties.serviceLevel` / SKU (Resource Graph does not return this).

#### Phase 2 — Per-volume metrics queries

For each discovered volume ARM path, `MetricsQueryClient.query_resource` fetches all nine metric types in one call:

```
GET https://management.azure.com{volume_arm_id}/providers/microsoft.insights/metrics
  ?region={default_region}
  &metricnames=ReadIops,WriteIops,ReadThroughput,WriteThroughput,AverageReadLatency,AverageWriteLatency,VolumeLogicalSize,VolumeAllocatedSize,VolumeSnapshotSize
  &metricnamespace=Microsoft.NetApp/netAppAccounts/capacityPools/volumes
  &interval=PT5M
  &aggregation=Average
  &timespan={watermark}/{now}
```

`default_region` must match the Azure region where ANF volumes run (e.g. `eastus2`). The client uses the ARM metrics endpoint with a `region` query parameter on every query; omitting `region` returns BadRequest for this namespace.

`testConnection` probes Azure Monitor with `ReadIops` only (per-volume query when volumes exist, subscription-scoped probe when none are found in the region) to validate credentials and API access without requesting the full metric set.

Key metric API names (portal labels differ):

- `ReadIops`, `WriteIops` (CountPerSecond, Average)
- `ReadThroughput`, `WriteThroughput` (BytesPerSecond, Average)
- `AverageReadLatency`, `AverageWriteLatency` (MilliSeconds → stored as microseconds ×1000)
- `VolumeLogicalSize`, `VolumeAllocatedSize`, `VolumeSnapshotSize` (Bytes; capacity gauges read `average` with fallback to `maximum`/`total`)

Volume identity is parsed from each metric result `id` (ARM path through `.../volumes/{name}`), from timeseries metadata keys (`resourceId`, etc.), or from the queried volume context when subscription-scoped metric IDs omit the volume path.

Partial volume failures are tolerated (other volumes still ingest); acquisition fails only when **all** volume queries fail or when zero ingestible series are returned across the estate.

### Watermark Semantics

Aligned with GCNV incremental rules; initial backfill uses Azure Monitor’s 93-day platform-metric retention (longer than GCNV’s 30-day default):

- First run (no watermark): 93-day backfill (chunked into ≤30-day Monitor queries per volume/pool)
- Incremental: since watermark, clamped to minimum 10-minute window (2× PT5M sample period)
- Advance watermark to max row timestamp when rows exist; **do not** advance on 0 rows
- Invalid watermark string → 93-day fallback

### Connection Info

```json
{
  "subscription_id": "00000000-0000-0000-0000-000000000001",
  "resource_group": "rg-anf-dev",
  "default_region": "eastus",
  "tenant_id": "...",
  "client_id": "...",
  "client_secret": "..."
}
```

Service principal credential keys: `tenant_id`, `client_id`, `client_secret`. RBAC: **Monitoring Reader** on the subscription (Reader on NetApp resources if required by tenant policy).

Parquet rows use `source_type="anf"` with `cluster_id` = NetApp account name (`netAppAccounts/{account}` segment). `service_level` is populated from the capacity pool's `serviceLevel` / SKU via a per-pool ARM lookup after volume discovery (Resource Graph and ARM enumeration paths).

---

## Parquet Schema

### Table 1: `volume_metrics`

| Column | Type | Description |
|--------|------|-------------|
| timestamp | TIMESTAMP | Collection time (UTC) |
| source_type | STRING | `"ontap"`, `"gcnv"`, or `"anf"` |
| cluster_id | STRING | ONTAP cluster ID, GCP project, or ANF NetApp account name |
| volume_id | STRING | Volume UUID or ARM volume resource ID |
| volume_name | STRING | Human-readable name |
| svm_name | STRING | ONTAP SVM (NULL for GCNV/ANF) |
| iops_read | FLOAT | Read IOPS |
| iops_write | FLOAT | Write IOPS |
| throughput_read_bytes | FLOAT | Read throughput (bytes/sec) |
| throughput_write_bytes | FLOAT | Write throughput (bytes/sec) |
| latency_avg_us | FLOAT | Average latency (microseconds) |
| space_used_bytes | INT64 | Space currently used |
| space_total_bytes | INT64 | Total allocated space |
| space_snapshot_bytes | INT64 | Space used by snapshots |
| qos_policy | STRING | QoS policy name (NULL for GCNV/ANF) |
| service_level | STRING | GCNV service level, ANF pool SKU, or ONTAP tier |
| quota_used_bytes | INT64 | Quota usage (NULL if no quota) |
| quota_limit_bytes | INT64 | Quota hard limit (NULL if no quota) |

### Table 2: `aggregate_metrics` (ONTAP only)

| Column | Type | Description |
|--------|------|-------------|
| timestamp | TIMESTAMP | Collection time (UTC) |
| source_type | STRING | Always `"ontap"` |
| cluster_id | STRING | Cluster ID |
| aggregate_id | STRING | Aggregate UUID |
| aggregate_name | STRING | Human-readable name |
| current_ops | FLOAT | Current operations |
| optimal_point_ops | FLOAT | Optimal headroom ops |
| available_ops | FLOAT | Available headroom ops |
| cold_data_bytes | INT64 | FabricPool cold data |
| total_data_bytes | INT64 | Total data on aggregate |
| cache_hit_ratio | FLOAT | Read cache hit percentage |

### Partitioning

Both tables partitioned by `date(timestamp)` for efficient range queries in DuckDB.

---

## Credential Resolution

| Provider | Mechanism | Location |
|----------|-----------|----------|
| ONTAP | Username + Password from `connectionInfo` | Stored encrypted in connector config (config-service) |
| GCNV | GCP service account JSON | Mounted at path specified in `credentials_path`; application-default credentials as fallback |

Credentials are never logged. The adapter receives them via `connectionInfo` dict at runtime.

---

## Error Handling

| Failure | Strategy |
|---------|----------|
| ONTAP API timeout | Activity retries (3 attempts, 30s backoff). Partial data discarded on retry. |
| GCP auth failure | Fail immediately (no retry). Alert required. |
| Partial API response (some counters fail) | Write available data, log warning. Don't fail entire acquisition. |
| Parquet write failure | Fail activity (retry will re-fetch). |
| Iceberg append failure | DatasetImportWorkflow has its own retry. |
| Duplicate data on re-run | Idempotent: same watermark window produces identical rows. DuckDB deduplicates at query time via `DISTINCT`. |

---

## Testing Strategy

### Unit Tests
- Adapter output schema validation (Parquet columns match expected schema)
- Watermark calculation (ONTAP: current time; GCNV: max timestamp from data)
- Connection info parsing and validation

### Integration Tests
- ONTAP adapter against mock ONTAP API (responses recorded from test cluster)
- GCNV adapter against Cloud Monitoring emulator or recorded responses
- Full `DataAcquisitionWorkflow` with `metrics` branch using mock adapters

### E2E Tests
- Create metrics connector → schedule acquisition → verify Iceberg table has data → query via DuckDB MCP
- Multiple acquisitions accumulate data (watermark advances)
- Verify DuckDB can query accumulated multi-day data with time filters
