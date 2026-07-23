# LanceDB vs PostgreSQL+pgvector Benchmark Suite

Apples-to-apples comparison of LanceDB (mounted filesystem) and PostgreSQL+pgvector
across 9 scenarios: scale, dimensions, content types, search modes, filtered search,
concurrent load, multi-KB serving, versioning/rollback, and storage durability.

## Prerequisites

- Python 3.11+
- Docker and Docker Compose (for pgvector)
- ~8 GB RAM recommended for large-scale tests

## Quick Start

```bash
# 1. Start pgvector infrastructure
docker compose up -d

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Run all benchmarks
python run_benchmarks.py --store both --scenario all

# 4. Run a single scenario on one store
python run_benchmarks.py --store lancedb --scenario scale

# 5. Run only pgvector tests
python run_benchmarks.py --store pgvector --scenario all
```

## Configuration

Edit `config.yaml` to adjust:
- LanceDB data directory (mounted filesystem path)
- PostgreSQL connection parameters
- Per-scenario parameters (vector counts, dimensions, thread counts, etc.)

## Scenarios

| # | Scenario | What it measures |
|---|----------|-----------------|
| 1 | Scale | Insert throughput, index build, latency, recall at 10K-1M vectors |
| 2 | Dimension | Impact of 128d-1536d on latency and recall |
| 3 | Content Type | Retrieval quality across text, structured, code, mixed content |
| 4 | Search Mode | Vector vs FTS vs Hybrid (RRF) comparison |
| 5 | Filter | Metadata filtering overhead at varying cardinalities |
| 6 | Concurrent | QPS and p99 under 1-64 concurrent threads |
| 7 | Multi-KB | Memory, cold-start, cross-KB query with 5-100 simultaneous KBs |
| 8 | Versioning | Blue-green switch latency, rollback, storage overhead |
| 9 | Durability | Backup/restore time, size, data integrity verification |

## Output

Results are written as JSON to `./results/` and a markdown summary report is
generated at `./results/report.md`.

## Notes

- **pgvector in Docker:** `docker-compose.yml` sets `shm_size: 1gb` because **HNSW** builds can fail with the default 64MB `/dev/shm` (`could not resize shared memory segment…`). The suite defaults to **IVFFlat** in scenarios for dev friendliness; enable HNSW after increasing `shm` and tuning `m` / `ef_construction`.
- **pgvector backup in the harness:** `PgvectorStore.backup` writes a **JSONL** file (no host `pg_dump` required). For production, use `pg_dump` or volume-level backup from the DB container/VM.

## Architecture

```
harness/
  base.py           Abstract VectorStore interface
  lancedb_store.py   LanceDB on mounted filesystem
  pgvector_store.py  PostgreSQL + pgvector
  datasets.py        Synthetic + SIFT dataset loaders
  embedder.py        SentenceTransformers wrapper
  metrics.py         Recall, NDCG, MRR, latency stats
  runner.py          Scenario orchestrator
  report.py          Markdown report generator

scenarios/
  scale_test.py              Scenario 1
  dimension_test.py          Scenario 2
  content_type_test.py       Scenario 3
  search_mode_test.py        Scenario 4
  filter_test.py             Scenario 5
  concurrent_test.py         Scenario 6
  multi_kb_test.py           Scenario 7
  versioning_test.py         Scenario 8
  storage_durability_test.py Scenario 9
```
