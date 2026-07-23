# LanceDB vs PostgreSQL+pgvector — design, operations, and benchmarks

This document compares **LanceDB** (Lance files on a **shared mounted filesystem**, the deployment model we evaluate here for apples-to-apples ops) and **PostgreSQL with the pgvector extension** for knowledge-base (KB) style vector search. It links to the [Platform HLD](platform-hld.md) and the current KB pipeline in [knowledge-base.md](knowledge-base.md).

## Doc map

- **Part A** — Why we compare, scope, current platform context.
- **Part B** — Feature matrix (from product documentation; index types, search modes, SQL, limits).
- **Part C** — Operations: multi-KB serving, rollback, backup/DR, replication, scaling.
- **Part D** — Benchmark harness: layout, how to run, index choices in this run.
- **Part E** — **Measured results** (representative; full tables in repo `src/benchmarks/vector-db-comparison/results/`).
- **Part F** — Recommendations and migration impact.

## When to read what

- **Choosing a store for a new project** — Parts B, C, F.
- **Reproducing or extending numbers** — Part D and the harness [README](../../src/benchmarks/vector-db-comparison/README.md).
- **Understanding operations on NFS/EFS vs PostgreSQL** — Part C.

---

## Part A — Overview and motivation

**Purpose:** Decide when LanceDB on shared storage is preferable vs co-locating vectors in PostgreSQL, and what tradeoffs apply to multi-tenant KBs, rollback, backup, and scale-out.

**Current platform (Agentstudio):** The KB RAG path uses **LanceDB** in [kb-retrieval-service](../../src/nemo/kb-retrieval-service/src/search/engine.rs) and the **kb-processor** [lancedb_writer.py](../../src/nemo/workers/kb-processor/processing/lancedb_writer.py). Production may use **S3** or a **shared filesystem**; this comparison stresses **local / NFS-like paths** to match a mounted-volume model (read-write-many PVC, EFS, NetApp) without per-request object HTTP latency. Shared PostgreSQL from [deployments/helm/database/](../../deployments/helm/database/) does not enable pgvector today; that remains an adoption decision.

**Scope:** ANN quality (recall, NDCG, MRR on synthetic data), insert/build latency, query latency, filtered and hybrid search, concurrency, multi-KB footprint, version switching, and backup/restore. We do **not** claim globally optimal tuning for every index; see Part D.

---

## Part B — Feature and architecture comparison

| Dimension | LanceDB (mounted FS) | pgvector (PostgreSQL) |
| --- | --- | --- |
| **Deployment** | Embedded library; data under a POSIX path | Server process; vectors in a table |
| **Primary ANN** | IVF-PQ, IVF-RQ, flat; tunable `nprobes` / `refine` | HNSW, IVFFlat; optional DiskANN extensions |
| **Distances** | L2, cosine, dot (API via `.metric()`) | L2, cosine, inner product; more in extension |
| **Vector dims** | Practically limited by model/PQ; no small fixed cap | `vector` type: 2000 dims (see pgvector release notes) |
| **FTS** | Tantivy/BM25 in product; `create_fts_index("text")` | `tsvector` + GIN; mature SQL |
| **Hybrid** | Native `query_type="hybrid"` + RRF reranker in stack | CTEs + RRF in SQL (implemented in harness) |
| **Filters** | SQL-like `where` on columns | Full SQL, joins, RLS |
| **Transactions** | Append-oriented Lance datasets | ACID, MVCC |
| **Versioning** | New directory per “blue-green” version; optional Lance time travel | Migrations, table clones, PITR |
| **Multi-tenancy** | One Lance table (or directory) per KB/tenant is typical | Single DB with `kb_id`, schemas, or RLS + pooling |

---

## Part C — Operational comparison

**Multi-KB / multi-tenant** — Lance: one table path per KB; a cache of open tables per pod (as in [pool.rs](../../src/nemo/kb-retrieval-service/src/pool.rs) for S3 paths). On a **shared mount**, the OS page cache is shared on a node, which can help repeated opens. **Risk:** NFS/EFS throughput and metadata rate under many parallel readers. PostgreSQL: many KBs in one or few tables, **cross-KB** queries possible with SQL, **connection pooling** (e.g. PgBouncer) is standard.

**Rollback** — Lance on disk: swap active path or symlink; prior directories kept until garbage collection. **PostgreSQL:** `ROLLBACK`, PITR, or clone/rename of tables. The benchmark measures **in-process switch** latency for both (see `versioning_*` JSON under `results/`).

**Backup / DR** — Lance: filesystem snapshots (array/NFS/EFS tools) or `rsync` of directories; the harness uses **directory copy** timing. **PostgreSQL:** `pg_basebackup`, WAL archive, PITR, managed backups. The harness’s pgvector `backup` uses a **portable JSONL** export to avoid requiring host `pg_dump` (for CI laptops); for production, use `pg_dump` or volume snapshots and document RPO/RTO.

**Replication** — Lance has no DB-level replication; rely on **storage** replication. PostgreSQL: **streaming replicas**, sync/async, and HA operators (e.g. Patroni, CloudNativePG).

**Scaling** — **Readers:** stateless app pods for both; DB cache vs Lance mmap + page cache. **Writers:** Lance = single-writer per dataset pattern in practice; PostgreSQL = concurrent `INSERT` with MVCC. HNSW builds on PostgreSQL can be **shared-memory heavy**; Docker’s default `shm` is small; the [docker-compose](../../src/benchmarks/vector-db-comparison/docker-compose.yml) sets `shm_size: 1gb` and the benchmark defaults to **IVFFlat** for pgvector to avoid OOM in dev.

---

## Part D — Test harness design

**Location:** [src/benchmarks/vector-db-comparison/](../../src/benchmarks/vector-db-comparison/).

- **LanceDB:** `LanceDBStore` — `data_dir` in `config.yaml` (default `./data/lance` under the repo) simulating a **shared RWX** path.
- **pgvector:** `PgvectorStore` + `docker compose` for [pgvector image](../../src/benchmarks/vector-db-comparison/docker-compose.yml) on `localhost:5432`.
- **Scenarios:** `scale`, `dimension`, `content_type`, `search_mode`, `filter`, `concurrent`, `multi_kb`, `versioning`, `durability` — see [README](../../src/benchmarks/vector-db-comparison/README.md).
- **Embeddings / data:** **Synthetic** normalized random vectors and brute-force **ground truth** (same for both stores) unless noted. This isolates the **engine**, not a specific sentence-transformer model.
- **Index choice (this run):** Both stores use **IVFFlat**-class indexes for apples-to-apples ANN: Lance **`IVF_FLAT`** with `num_partitions=100` and query-time **`nprobes=10`**, and pgvector **`ivfflat`** with `lists=100` and **`SET ivfflat.probes = 10`**. (Lance still supports **IVF_PQ** in the harness for optional runs.) **HNSW** is optional for pgvector when `shm` and RAM allow. Part E is **harness-comparable** under this shared IVF + flat-cells tuning, not a “max recall” competition.

**Run:** `cd src/benchmarks/vector-db-comparison && pip install -r requirements.txt && python run_benchmarks.py --store both --scenario all`

**Machine-generated report:** [results/report.md](../../src/benchmarks/vector-db-comparison/results/report.md) (merged tables from all JSON in `results/`).

---

## Part E — Benchmark results (local run, 2026)

*Environment: Apple Silicon host, Python 3.14 venv, Docker `pgvector/pgvector:pg17` with `shm_size: 1gb`. Config: `config.yaml` with reduced row counts for CI-friendly duration (e.g. scale up to 100K vectors, multi-KB 2 and 5 KBs). **Numbers below** are from the latest JSON in `src/benchmarks/vector-db-comparison/results/` (`scale_lancedb_100000_ivfflat.json`, `scale_pgvector_100000_ivfflat.json`, `versioning_*.json`, `durability_*.json`).*

### E.1 Throughput and latency at scale (100K vectors, 384d, cosine, IVFFlat on both)

| Metric | LanceDB (`IVF_FLAT`, 100 parts, 10 probes) | pgvector (`ivfflat`, lists=100, 10 probes) |
| --- | --- | --- |
| Insert throughput (vec/s) | 104,231 | 1,910 |
| Index build (s) | 1.36 | 1.56 |
| Index size (MB) | 302 | 164 |
| Peak process memory (MB) | 1,757 | 426 |
| p50 query latency (ms) | 2.45 | 3.14 |
| p99 query latency (ms) | 4.54 | 4.60 |
| QPS (200 queries) | 388 | 307 |
| Recall@10 (synthetic) | 0.23 | 0.22 |
| NDCG@10 (synthetic) | 0.37 | 0.35 |
| MRR (synthetic) | 0.94 | 0.86 |

**Interpretation:** With **matching IVF + flat-cell** index families and **10 probes** on each side, **recall/NDCG/MRR** track closely. **Lance** remains far ahead on **insert** throughput and uses more **RSS** in this process-local harness; on-disk **index** size is larger on Lance. **p50** latency is a bit lower on **Lance** in this run; **p99** and **QPS** are in the same neighborhood (Lance QPS higher here). Figures fluctuate with machine load—see `scale_*_100000_ivfflat.json` and `results/report.md` for the exact run.

### E.2 Version switch (2 versions, 10K vectors)

- **LanceDB** (`versioning_lancedb_2v.json`): p50 **~3.5 ms** / p99 **~5.8 ms** over switch samples; last rollback to v1 **~1.25 ms** (`rollback_last_switch_ms`). Versions **v1**, **v2** listed.
- **pgvector** (`versioning_pgvector_2v.json`): table-name switch **&lt; 0.1 ms** (p50 **0.003 ms**); last rollback **0.001 ms**. Clones + pointer swap, not a full re-ingest on switch.

### E.3 Backup / restore (10K vectors)

- **LanceDB** (`durability_lancedb_backup_restore.json`): directory copy **0.04 s** backup, **0.03 s** restore, **30.3 MB**; **100%** top-20 query ID match vs pre-backup; **10,000** rows after restore.
- **pgvector** (`durability_pgvector_backup_restore.json`): JSONL export **~0.49 s**, import **~4.6 s**, **~45.6 MB** file; **10,000** rows verified. Top-k **ID** match to pre-backup is **0%** in the harness (`integrity_pct`—ANN reindexed after import; use as timing/row-count check; use `pg_dump` for bitwise-identical backup tests).

For **multi-KB**, **concurrent** load, **filter**, and **search mode** (vector / FTS / hybrid) numbers, see `results/*.json` and the merged `report.md`.

---

## Part F — Recommendations

1. **Stay on LanceDB** when the team prioritizes **embedded, file-centric** vector storage, **S3 or POSIX** durability with blue-green paths, and the existing **kb-retrieval-service** / **kb-processor** path with minimal change.
2. **Adopt or trial pgvector** when you need **one relational system** for **metadata, ACLs, joins, and cross-KB SQL**, proven **replication/backup** tooling, and DBA-familiar **observability** (e.g. `pg_stat*`). Expect **migrations** for tables, indexes, and a different **write path** than the Lance writer.
3. **Hybrid architecture:** Keep Lance for the **highest-scale embedding store** and sync selective metadata to PostgreSQL for **product queries** — only if operational complexity is acceptable.
4. **Service impact** if moving query to PostgreSQL: replace or branch [kb-retrieval-service](../../src/nemo/kb-retrieval-service) query path; adjust [kb-processor](../../src/nemo/workers/kb-processor) to write to Postgres; extend Helm with pgvector and connection secrets.

**Infrastructure (mounted Lance):** provision **ReadWriteMany** volumes with enough **IOPS/throughput**; monitor NFS latency. **PostgreSQL:** set `shared_buffers` / `work_mem` and **HNSW `shm_size`** in Docker/Kubernetes appropriately.

---

## References

**Internal**

- [Platform HLD](platform-hld.md), [knowledge-base.md](knowledge-base.md)
- [kb-retrieval-service search engine](../../src/nemo/kb-retrieval-service/src/search/engine.rs), [lancedb_writer.py](../../src/nemo/workers/kb-processor/processing/lancedb_writer.py)
- Benchmark harness: [vector-db-comparison](../../src/benchmarks/vector-db-comparison/) (including [results/report.md](../../src/benchmarks/vector-db-comparison/results/report.md))

**External**

- [LanceDB](https://lancedb.com/docs/) — indexing, hybrid search, FTS
- [pgvector](https://github.com/pgvector/pgvector) — HNSW, IVFFlat, distance ops
- [VectorDBBench](https://github.com/zilliztech/VectorDBBench) — community benchmark tool (not required for this harness, but a useful cross-check)
- [CloudNativePG](https://cloudnative-pg.io/) — Kubernetes PostgreSQL with backup/replication (optional for ops comparison)
