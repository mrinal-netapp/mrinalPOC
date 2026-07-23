"""Scenario 2: Dimension Test -- fixed 100K vectors, vary dimensions.

Dimensions: 128, 384, 768, 1024, 1536. Measures latency and recall impact.
"""

import logging

from harness.base import VectorStore
from harness.datasets import generate_synthetic
from harness.metrics import BenchmarkResult
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
    dimensions: list[int] | None = None,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    dimensions = dimensions or [128, 384, 768, 1024, 1536]
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    results = []

    for dim in dimensions:
        label = f"dim_{dim}"
        logger.info("=== Dimension Test: %s, %dd, %d vectors ===", store_type, dim, count)

        dataset = generate_synthetic(count, dim, num_queries=200, k=50)

        try:
            insert_time, build_time = runner.run_insert_and_index(
                dataset, label, idx_type, metric, **idx_params
            )
            result = runner.run_query_benchmark(dataset, top_k=top_k)
            result.scenario = "dimension"
            result.store_type = store_type
            result.index_type = idx_type
            result.params = {"count": count, "dimension": dim}
            result.insert_throughput = count / insert_time if insert_time > 0 else 0
            result.index_build_seconds = build_time

            runner._save_result(result, suffix=f"{dim}d")
            results.append(result)
        except Exception:
            logger.exception("Failed: %s", label)
        finally:
            store.drop_collection()

    return results
