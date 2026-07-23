"""Scenario 3: Content Type Test -- different content types from production KB pipeline.

Evaluates retrieval quality (NDCG, MRR) across plain text, structured data,
code snippets, and mixed-format documents.
"""

import logging

from harness.base import VectorStore
from harness.datasets import generate_content_types
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
    count_per_type: int = 5000,
    dimension: int = 384,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    results = []

    datasets = generate_content_types(count_per_type, dimension, num_queries=50)

    for content_type, dataset in datasets.items():
        label = f"content_{content_type}"
        logger.info("=== Content Type Test: %s, %s ===", store_type, content_type)

        try:
            insert_time, build_time = runner.run_insert_and_index(
                dataset, label, idx_type, metric, **idx_params
            )
            result = runner.run_query_benchmark(dataset, top_k=top_k, num_queries=50)
            result.scenario = "content_type"
            result.store_type = store_type
            result.index_type = idx_type
            result.params = {"content_type": content_type, "count": count_per_type}
            result.insert_throughput = count_per_type / insert_time if insert_time > 0 else 0
            result.index_build_seconds = build_time

            runner._save_result(result, suffix=content_type)
            results.append(result)
        except Exception:
            logger.exception("Failed: %s", label)
        finally:
            store.drop_collection()

    return results
