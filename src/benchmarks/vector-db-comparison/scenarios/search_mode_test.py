"""Scenario 4: Search Mode Comparison -- vector vs FTS vs hybrid.

Same query set, measures recall, precision, latency across modes.
Compares LanceDB native hybrid vs pgvector CTE-based hybrid.
"""

import logging

import numpy as np

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
    dimension: int = 384,
    num_queries: int = 200,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    results = []

    dataset = generate_synthetic(count, dimension, num_queries=num_queries, k=50)

    label = "search_mode"
    logger.info("=== Search Mode Test: %s, inserting data ===", store_type)
    insert_time, build_time = runner.run_insert_and_index(
        dataset, label, idx_type, metric, **idx_params
    )

    try:
        logger.info("--- Vector search ---")
        vec_result = runner.run_query_benchmark(dataset, top_k=top_k, num_queries=num_queries)
        vec_result.scenario = "search_mode"
        vec_result.store_type = store_type
        vec_result.index_type = idx_type
        vec_result.params = {"mode": "vector", "count": count}
        runner._save_result(vec_result, suffix="vector")
        results.append(vec_result)

        logger.info("--- FTS search ---")
        query_texts = [f"Document {np.random.randint(0, count)}" for _ in range(num_queries)]
        gt_ids = [[int(qt.split()[-1])] for qt in query_texts]
        fts_result = runner.run_fts_benchmark(query_texts, gt_ids, top_k=top_k)
        fts_result.scenario = "search_mode"
        fts_result.store_type = store_type
        fts_result.index_type = idx_type
        fts_result.params = {"mode": "fts", "count": count}
        runner._save_result(fts_result, suffix="fts")
        results.append(fts_result)

        logger.info("--- Hybrid search ---")
        hybrid_result = runner.run_hybrid_benchmark(
            dataset.queries[:num_queries],
            query_texts,
            [list(row) for row in dataset.ground_truth[:num_queries]],
            top_k=top_k,
        )
        hybrid_result.scenario = "search_mode"
        hybrid_result.store_type = store_type
        hybrid_result.index_type = idx_type
        hybrid_result.params = {"mode": "hybrid", "count": count}
        runner._save_result(hybrid_result, suffix="hybrid")
        results.append(hybrid_result)

    except Exception:
        logger.exception("Failed: search_mode")
    finally:
        store.drop_collection()

    return results
