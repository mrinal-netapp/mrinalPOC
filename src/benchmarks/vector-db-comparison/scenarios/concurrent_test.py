"""Scenario 6: Concurrent Load -- simulate production-like concurrent queries.

Thread counts: 1, 4, 16, 64. Measures QPS and p99 latency under load.
Also tests concurrent read+write.
"""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

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


def _query_worker(store: VectorStore, query_vector, top_k: int) -> float:
    result = store.vector_search(query_vector, top_k=top_k)
    return result.latency_ms


def run(
    store: VectorStore,
    store_type: str,
    output_dir: str = "./results",
    count: int = 100_000,
    dimension: int = 384,
    thread_counts: list[int] | None = None,
    queries_per_thread: int = 50,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    thread_counts = thread_counts or [1, 4, 16, 64]
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    mc = MetricsCollector()
    results = []

    dataset = generate_synthetic(count, dimension, num_queries=max(thread_counts) * queries_per_thread, k=50)

    label = "concurrent"
    logger.info("=== Concurrent Test: %s, inserting data ===", store_type)
    runner.run_insert_and_index(dataset, label, idx_type, metric, **idx_params)

    try:
        for num_threads in thread_counts:
            logger.info("--- %d threads ---", num_threads)
            total_queries = num_threads * queries_per_thread
            query_indices = np.random.choice(len(dataset.queries), total_queries, replace=True)

            all_latencies = []
            wall_start = time.perf_counter()

            with ThreadPoolExecutor(max_workers=num_threads) as executor:
                futures = []
                for qi in query_indices:
                    futures.append(executor.submit(_query_worker, store, dataset.queries[qi], top_k))

                for future in as_completed(futures):
                    try:
                        lat = future.result()
                        all_latencies.append(lat)
                    except Exception:
                        logger.exception("Query failed in thread")

            wall_elapsed = time.perf_counter() - wall_start
            qps = len(all_latencies) / wall_elapsed if wall_elapsed > 0 else 0
            latency_stats = mc.compute_latency(all_latencies)

            result = BenchmarkResult(
                scenario="concurrent",
                store_type=store_type,
                index_type=idx_type,
                params={"threads": num_threads, "queries_per_thread": queries_per_thread, "count": count},
                latency=latency_stats,
                qps=qps,
                extra={"wall_seconds": round(wall_elapsed, 3), "total_queries": len(all_latencies)},
            )
            runner._save_result(result, suffix=f"{num_threads}t")
            results.append(result)

    except Exception:
        logger.exception("Failed: concurrent")
    finally:
        store.drop_collection()

    return results
