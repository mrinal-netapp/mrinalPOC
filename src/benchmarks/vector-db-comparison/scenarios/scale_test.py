"""Scenario 1: Scale Test -- vary dataset size from 10K to 1M vectors.

Fixed: 384d, cosine, top-10. Measures insert throughput, index build time,
index size, query latency, and recall at each scale point.
"""

import logging

from harness.base import VectorStore
from harness.datasets import generate_synthetic
from harness.metrics import BenchmarkResult, MetricsCollector
from harness.runner import BenchmarkRunner

logger = logging.getLogger(__name__)

INDEX_CONFIGS = {
    "lancedb": [
        ("flat", {}),
        ("ivfflat", {"num_partitions": 100, "probes": 10}),
    ],
    "pgvector": [
        ("flat", {}),
        ("ivfflat", {"lists": 100, "probes": 10}),
    ],
}


def run(
    store: VectorStore,
    store_type: str,
    output_dir: str = "./results",
    sizes: list[int] | None = None,
    dimension: int = 384,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    sizes = sizes or [10_000, 100_000, 500_000, 1_000_000]
    runner = BenchmarkRunner(store, store_type, output_dir)
    configs = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    results = []

    for count in sizes:
        dataset = generate_synthetic(count, dimension, num_queries=200, k=50)
        for idx_type, idx_params in configs:
            if idx_type == "ivfflat" and count < 10_000:
                continue

            label = f"scale_{count}_{idx_type}"
            logger.info("=== Scale Test: %s, %s, %d vectors ===", store_type, idx_type, count)

            try:
                insert_time, build_time = runner.run_insert_and_index(
                    dataset, label, idx_type, metric, **idx_params
                )
                result = runner.run_query_benchmark(dataset, top_k=top_k)
                result.scenario = "scale"
                result.store_type = store_type
                result.index_type = idx_type
                result.params = {"count": count, "dimension": dimension, **idx_params}
                result.insert_throughput = count / insert_time if insert_time > 0 else 0
                result.index_build_seconds = build_time

                runner._save_result(result, suffix=f"{count}_{idx_type}")
                results.append(result)
            except Exception:
                logger.exception("Failed: %s", label)
            finally:
                store.drop_collection()

    return results
