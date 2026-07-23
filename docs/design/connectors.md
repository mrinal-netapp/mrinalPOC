# Connector system design

Connectors are part of the platform described in [Platform HLD](platform-hld.md). They provide the link between external data sources and **datasets** (see [datasets.md](datasets.md)): a connector is a configured connection to an external source (e.g. database or object store); [datasets](datasets.md) of type *acquired* use a connector to pull data on a schedule or on demand.

## Doc map

- **Entity model** — DataSource (connectors), DataSet (acquisition fields).
- **Credential flow** — Worker auth (Keycloak), secret-data endpoint, credential keys per provider.
- **Acquisition workflow** — DataAcquisitionWorkflow steps, overwrite semantics, activity input.
- **Scheduling** — Create/update/delete schedule, Temporal Schedule API.
- **Incremental** — Watermark-based acquisition, watermark update endpoint.
- **Guards** — Query timeout, maxRows, memory, concurrency, activity timeout.
- **Future** — Kafka/streams, GCS.

## When to read what

- **Implementing acquisition?** → §Acquisition workflow and connector-worker; §Credential flow for secrets.
- **Adding a connector type?** → §Entity model and §Credential flow (credential keys per provider).
- **Scheduling or incremental?** → §Scheduling and §Incremental acquisition.

## Overview

The connector system enables users to acquire data from external sources (RDBMS, S3) into [datasets](datasets.md) on a schedule or on demand. It reuses the existing `DataSource` entity (with `type: 'connector'`), adds a Python connector-worker for data acquisition, and orchestrates everything through [Temporal](https://docs.temporal.io/) workflows.

**What** a connector is: a configured connection to an external source — a database (PostgreSQL, MySQL) or an object store (S3, GCS). **Why** we have them: to bring external data into the platform as datasets so it can be used by pipelines, knowledge bases, and analytics. **Who** is involved: the user creates a connector and credential in the GUI; Config Service stores them. The user creates or links a dataset to the connector; on schedule or on demand, the Workflow Engine runs DataAcquisitionWorkflow, the connector-worker pulls data from the external source, and DatasetImportWorkflow lands the data in project storage.

## Architecture

```text
GUI -> Config Service -> DataSource (type=connector, connectorConfig, credentialId)
                      -> Credential (K8s Secrets)
                      -> DataSet (originConnector, sqlQuery, acquisitionConfig, scheduleConfig)

Workflow Engine (Go) -> DataAcquisitionWorkflow
                     -> ConfigClient.GetDataset / GetDataSource
                     -> Temporal ScheduleClient
                     -> DatasetImportWorkflow (existing, unchanged)

Connector Worker (Python) -> AcquireFromDatabaseActivity (DuckDB)
                           -> AcquireFromObjectStoreActivity (boto3)
                           -> RegisterVolumeFiles (POSIX walk, zero-copy)
                           -> TestDatabase / TestObjectStore
                           -> DiscoverSchema / ListFiles
                           -> PreviewDatabase / PreviewObjectStore
                           -> ClearDatasetPathActivity
```

## Entity Model

### DataSource (connectors)

- **PK:** `varchar(12)` — `cn-<8 base36>` for connectors (11 chars), `vol-<8 base36>` for volumes (12 chars)
- **credentialId:** `varchar(36)` — soft FK to Credential.id
- **connectorConfig:** JSONB with typed fields per connector_type:
  - `database`: host, port, database, schema, ssl_mode, database_type (postgresql|mysql)
  - `objectstore`: provider (s3|gcs), endpoint, bucket, prefix, region
  - `storage`: cluster_url, verify_tls, default_svm (NetApp ONTAP)
- **ConnectorSubType:** `'database' | 'objectstore' | 'storage'` (filestore/stream removed until implemented)

### DataSet (acquisition)

- **originConnector:** `varchar(12)` — soft FK to DataSource.id (for objectstore/database sources)
- **originVolume:** `varchar(12)` — soft FK to DataSource.id where `type='volume'` (for ONTAP/NFS volume sources). Mutually exclusive with `originConnector`; validator rejects if both are set. See [datasets.md](datasets.md) §Source types.
- **sqlQuery:** existing `text` field reused for connector SQL
- **acquisitionConfig:** JSONB — fileGlob, writeMode (append|overwrite|incremental), watermarkColumn, lastWatermarkValue, maxRows, queryTimeoutSeconds
- **scheduleConfig:** JSONB — cronExpression, timezone, temporalScheduleId, enabled

## Credential Flow

### Worker Auth

The connector-worker authenticates to config-service using **Keycloak client credentials**:

1. Worker pod receives `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`, and token URL via Helm env vars
2. Worker obtains a JWT using the OAuth2 client-credentials grant
3. Worker sends the JWT in the `Authorization` header when calling the secret-data endpoint

**Recommendation:** Use a dedicated Keycloak client (e.g. `connector-worker`) so the secret-data endpoint can restrict access by checking `client_id` in the JWT. A shared client is acceptable if both workflow-engine and connector-worker are equally trusted.

### Secret-Data Endpoint

`POST /api/v1/projects/:projectId/credentials/:id/secret-data`

- Restricted to service-account JWTs (reject user tokens)
- Uses existing `CredentialService.readSecretData()` which reads from K8s via `K8sSecretService`
- Response: `{ "username": "...", "password": "..." }` (key-value pairs)
- Credentials stay in-memory in the worker; never written to Temporal persistence

### Credential Secret Keys per Provider

| Provider            | K8s Secret Keys                                                                         |
| ------------------- | --------------------------------------------------------------------------------------- |
| postgresql / mysql  | `username`, `password`                                                                  |
| s3                  | `access_key_id`, `secret_access_key`                                                    |
| gcs                 | (future — document when implemented)                                                    |
| ontap               | `username`+`password` OR `client_cert_pem`+`client_key_pem` (+ optional `ca_bundle_pem`) |

### Internal S3 Credentials

Connector-worker reads internal MinIO credentials from pod env vars (`S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`) injected by Helm. These are NOT passed via Temporal activity input.

## ConfigClient Getters

Added to workflow-engine's ConfigClient:

- **GetDataset(projectId, datasetId)** — `GET /api/v1/projects/{projectId}/datasets/{datasetId}`
- **GetDataSource(projectId, dataSourceId)** — `GET /api/v1/projects/{projectId}/datasources/{dataSourceId}`

The workflow fetches dataset + connector config, then passes connectorConfig in the activity input. The worker does NOT call GET datasource; it only calls the secret-data endpoint.

## Acquisition Modes

The platform supports multiple acquisition paths depending on the data source type and feature flags. This table summarizes the available modes:

| Mode | Source type | Flag | Workflow chain | Default |
|------|------------|------|---------------|---------|
| Streaming pipeline | Object store (S3) | `ACQ_USE_PIPELINE=true` | `DiscoverSourceItems` → N × `AcquireBatch` → `FinalizeAcquisition` → `DatasetImportWorkflow` | Yes |
| Legacy object store | Object store (S3) | `ACQ_USE_PIPELINE=false` | `AcquireFromObjectStore` → `DatasetImportWorkflow` | No |
| Database | PostgreSQL, MySQL | — | `AcquireFromDatabase` → `DatasetImportWorkflow` | Always |
| Volume (zero-copy) | ONTAP / NFS mount | — | `RegisterVolumeFiles` (no import chain) | Always |
| API | Redash, etc. | — | `AcquireFromAPI` → `DatasetImportWorkflow` | Always |

The streaming pipeline is the default for object store sources. It uses Redis streams for backpressure-controlled concurrent discovery and registration. For the full streaming pipeline design, see [stream-pipeline.md](stream-pipeline.md). For volume-specific details, see [ontap-connector.md](ontap-connector.md). For dataset lifecycle and how acquisition feeds into datasets, see [datasets.md](datasets.md).

## Acquisition Workflow

### DataAcquisitionWorkflow Steps

1. Fetch dataset via `ConfigClient.GetDataset`
2. **Branch on source type:**
   - **`originVolume` set** → volume acquisition path (see §Volume acquisition below)
   - **`originConnector` set** → connector path (steps 3–7)
3. Fetch connector via `ConfigClient.GetDataSource`
4. If writeMode == "overwrite": dispatch `ClearDatasetPathActivity` for `.../datasets/<id>/data_files`, then again for `.../datasets/<id>/_acquisition` (metadata scratch)
5. Dispatch typed acquisition activity (`AcquireFromDatabase` or objectstore streaming pipeline `DiscoverSourceItems` → N × `AcquireBatch` → `FinalizeAcquisition`)
6. `FinalizeAcquisition` writes `filelist.json` at `projects/<projectId>/datasets/<datasetId>/_acquisition/filelist.json` (payload copies remain under `.../data_files/`)
7. Build `DatasetImportWorkflowInput` with `FileListKey` from acquisition result; start `DatasetImportWorkflow` as child workflow. `CreateWorkPlanActivity` reads the pre-built list (with sizes) and derives shard count `K` from total bytes and env (`WORK_UNIT_MAX_MB`, `MAX_WORK_UNITS`, `SCATTER_MAX_UNITS_CEILING`, etc.); see [workflows.md](workflows.md) §7.2.
8. Update status via existing `PUT .../datasets/:id/status`
9. Update watermark via `PATCH .../datasets/:id` (merges into acquisitionConfig JSONB)

### Volume acquisition (zero-copy)

When a dataset has `originVolume` set, the workflow skips the connector/credential path and runs the **streaming volume pipeline** (see [stream-pipeline.md](stream-pipeline.md)):

1. Fetch volume DataSource config via `FetchDataSourceConfigActivity`
2. Resolve mount path from PVC naming convention (`/mnt/pvcs/{volumeName}` + `filterSpec.sourcePath`)
3. Concurrent `DiscoverVolumeFiles` + `RegisterBatch` (Redis-backed) — **no data is copied** into nemo-default; registration records URIs/paths on the volume.
4. `FinalizeRegistration` writes `manifest.json` under `projects/<projectId>/datasets/<datasetId>/_acquisition/`.
5. Chain `DatasetImportWorkflow` with `FileListKey` set to that manifest key.
6. Persist `maxMtime` via `UpdateDatasetWatermarkActivity` when not overwrite.

The ONTAP volume is mounted **read-only**. See [datasets.md](datasets.md) §Acquired datasets and [ontap-connector.md](ontap-connector.md) §Volume acquisition.

### FileListKey and pre-built file lists

Streaming object store (`FinalizeAcquisition`) produces **`filelist.json`**; volume streaming (`FinalizeRegistration`) produces **`manifest.json`** (parquet-partitioned). Both live under **`projects/<projectId>/datasets/<datasetId>/_acquisition/`**. Example `filelist.json` shape:

```json
{
  "files": [
    { "key": "projects/p1/datasets/d1/data_files/foo.csv", "size": 1234 },
    { "local_path": "/mnt/volumes/vol1/data/bar.csv", "size": 5678, "lastModified": "2026-04-01T..." }
  ],
  "totalFiles": 2
}
```

The key is propagated: `DataAcquisitionWorkflowResult.fileListKey` → `DatasetImportWorkflowInput.FileListKey` → `CreateWorkPlanInput.FileListKey`. When present, `CreateWorkPlanActivity` reads the pre-built list instead of performing an S3/POSIX directory listing. When empty (manual uploads, KB workflows), the activity falls back to listing.

### Overwrite Semantics

- `ClearDatasetPathActivity` runs on `connector-operations` queue (connector-worker has S3 env vars)
- Lists and deletes all objects under the dataset data path
- After re-acquiring, DatasetImportWorkflow should **replace** the Iceberg table (not append)
- If DatasetImportWorkflow currently always appends, overwrite requires an option/branch

### Activity Input

The workflow passes full connector config (non-secret) so the worker doesn't need to call GET datasource. Worker only calls config-service for `POST .../credentials/:id/secret-data`.

## Resource Guards

- **Query timeout:** Postgres `statement_timeout` via connection string; MySQL `SET SESSION max_execution_time`
- **maxRows:** When set and not incremental, activity wraps query with `LIMIT {maxRows}` (default 1M)
- **Memory limit:** DuckDB `SET memory_limit='2GB'`
- **Concurrency:** Temporal `MaxConcurrentActivities=2`
- **Activity timeout:** `ScheduleToCloseTimeout` default 30min

## Scheduling

### Create/Update (Create-Replace Semantics)

- `POST .../datasets/:id/schedule` with body `{ cronExpression, timezone, enabled }`
- On create: create Temporal Schedule, store `temporalScheduleId` in scheduleConfig
- On update: delete existing schedule by stored ID, create new one, update ID
- `DELETE .../datasets/:id/schedule`: delete by ID, clear from scheduleConfig
- `GET .../datasets/:id/schedule`: returns info from `ScheduleHandle.Describe()` (no duplicated state)

### Temporal Schedule API

Uses Go SDK `ScheduleClient().Create()` with `ScheduleWorkflowAction` targeting `DataAcquisitionWorkflow`.

## Incremental Acquisition

### Watermark-Based (databases)

1. User sets `watermarkColumn` (e.g. `updated_at`) in acquisitionConfig
2. First run: full query + extract max watermark
3. Subsequent runs: inject `WHERE {watermarkColumn} > {parameterized_lastWatermark}`
4. Activity **parameterizes or sanitizes** the watermark value (quote/escape per DB type) to prevent SQL injection
5. New watermark stored in `acquisitionConfig.lastWatermarkValue` via watermark update endpoint

### mtime watermark (volumes)

Volume-sourced datasets use file `st_mtime` as the watermark. `RegisterVolumeFiles` accepts `lastMtimeWatermark` (ISO 8601) and skips files where `mtime ≤ watermark`. It returns `maxMtime` — the newest `st_mtime` seen — which the workflow persists via the same watermark endpoint. Write modes: `append` uses mtime filtering; `overwrite` ignores the watermark and registers all files; `incremental` uses mtime filtering. No schema changes are needed — `lastWatermarkValue` is already a generic string field.

### Watermark Update Endpoint

`PATCH /api/v1/projects/:projectId/datasets/:id` with body `{ "acquisitionConfig": { "lastWatermarkValue": "..." } }` — merges into existing JSONB without overwriting unrelated fields.

## API Field Name Convention

Request bodies use `credential_id` (snake_case). Routes map to entity field `credentialId` (camelCase) for DB persistence.

## Future: Kafka / Streams

Deferred to separate design. Key difference: persistent K8s Deployment consumer, not a Temporal activity. Add `'stream'` back to ConnectorSubType when designed.

## GCS Support

Config validates `provider: 'gcs'`; only S3 is implemented initially. GCS in a later phase.

## References

- **Internal:** [Platform HLD](platform-hld.md), [datasets.md](datasets.md), workflow-engine (ConfigClient, DataAcquisitionWorkflow), connector-worker (Python activities).
- **External:** [Temporal](https://docs.temporal.io/), [Keycloak client credentials](https://www.keycloak.org/docs/latest/securing_apps/#_client_credentials), [DuckDB](https://duckdb.org/docs/), [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/). For schedule semantics see Temporal schedules in the Temporal docs.
