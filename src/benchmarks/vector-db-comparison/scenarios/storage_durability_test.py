"""Scenario 9: Storage Durability and Recovery -- backup, restore, integrity.

Populates a KB with 100K vectors + indexes, then measures backup time/size,
restore time, and verifies data integrity post-restore.
"""

import logging

import numpy as np

from harness.base import VectorStore
from harness.datasets import generate_synthetic
from harness.metrics import BenchmarkResult, MetricsCollector
from harness.runner import BenchmarkRunner

logger = logging.getLogger(__name__)

INDEX_CONFIGS = {
    "lancedb": ("ivfflat", {"num_partitions": 100, "probes": 10}),
    "pgvector": ("ivfflat", {"lists": 100, "probes": 10}),
}


def run(
    store: VectorStore,
    store_type: str,
    output_dir: str = "./results",
    count: int = 100_000,
    dimension: int = 384,
    metric: str = "cosine",
    top_k: int = 10,
    backup_path: str = "/tmp/vectordb_backup",
) -> list[BenchmarkResult]:
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    mc = MetricsCollector()
    results = []

    logger.info("=== Durability Test: %s ===", store_type)

    try:
        dataset = generate_synthetic(count, dimension, num_queries=100, k=50, seed=42)
        runner.run_insert_and_index(dataset, "durability", idx_type, metric, **idx_params)

        pre_backup_ids = []
        for qvec in dataset.queries[:20]:
            r = store.vector_search(qvec, top_k=top_k)
            pre_backup_ids.append([res.id for res in r.results])

        logger.info("  Running backup...")
        backup_metrics = store.backup(backup_path)
        bpath = backup_metrics.path
        logger.info("  Backup: %.2fs, %.1f MB to %s", backup_metrics.elapsed_seconds, backup_metrics.size_mb, bpath)

        store.drop_collection()
        if store_type == "pgvector":
            # Empty schema: restore loads rows; indexes must be rebuilt to query
            store.create_collection("durability", dimension, metric)

        logger.info("  Running restore...")
        restore_metrics = store.restore(bpath)
        if store_type == "pgvector":
            store.create_index(idx_type, **idx_params)
        logger.info("  Restore: %.2fs", restore_metrics.elapsed_seconds)

        post_restore_ids = []
        for qvec in dataset.queries[:20]:
            r = store.vector_search(qvec, top_k=top_k)
            post_restore_ids.append([res.id for res in r.results])

        integrity_matches = 0
        for pre, post in zip(pre_backup_ids, post_restore_ids):
            if pre == post:
                integrity_matches += 1
        integrity_pct = integrity_matches / len(pre_backup_ids) * 100

        row_count = store.count()
        count_matches = row_count == count

        result = BenchmarkResult(
            scenario="durability",
            store_type=store_type,
            index_type=idx_type,
            params={"count": count, "dimension": dimension},
            index_size_mb=backup_metrics.size_mb,
            extra={
                "backup_seconds": round(backup_metrics.elapsed_seconds, 3),
                "backup_size_mb": round(backup_metrics.size_mb, 2),
                "restore_seconds": round(restore_metrics.elapsed_seconds, 3),
                "integrity_pct": round(integrity_pct, 1),
                "count_verified": count_matches,
                "row_count_after_restore": row_count,
            },
        )
        runner._save_result(result, suffix="backup_restore")
        results.append(result)

    except Exception:
        logger.exception("Failed: durability")
    finally:
        store.drop_collection()

    return results
