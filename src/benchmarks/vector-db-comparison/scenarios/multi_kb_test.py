"""Scenario 7: Multi-KB Serving -- multiple knowledge bases served simultaneously.

Creates N independent KBs (5, 20, 50, 100) each with 50K vectors.
Measures aggregate memory, cold-start latency, cache eviction impact,
cross-KB query performance, and per-KB latency under full load.
"""

import logging
import time

import numpy as np

from harness.base import VectorStore
from harness.datasets import generate_synthetic
from harness.metrics import BenchmarkResult, MetricsCollector

logger = logging.getLogger(__name__)

INDEX_CONFIGS = {
    "lancedb": ("ivfflat", {"num_partitions": 100, "probes": 10}),
    "pgvector": ("ivfflat", {"lists": 100, "probes": 10}),
}


def run(
    store_factory,
    store_type: str,
    output_dir: str = "./results",
    kb_counts: list[int] | None = None,
    vectors_per_kb: int = 50_000,
    dimension: int = 384,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    """
    Args:
        store_factory: Callable that returns a new VectorStore instance.
            For pgvector, all KBs share one PostgreSQL; for LanceDB, each
            KB gets its own directory on the shared mount.
    """
    kb_counts = kb_counts or [5, 20, 50, 100]
    mc = MetricsCollector()
    results = []

    query_dataset = generate_synthetic(vectors_per_kb, dimension, num_queries=50, k=50)

    for n_kbs in kb_counts:
        logger.info("=== Multi-KB Test: %s, %d KBs x %d vectors ===", store_type, n_kbs, vectors_per_kb)

        stores: list[VectorStore] = []
        insert_times = []

        try:
            for kb_idx in range(n_kbs):
                store = store_factory()
                stores.append(store)
                dataset = generate_synthetic(
                    vectors_per_kb, dimension, num_queries=10, k=50, seed=42 + kb_idx
                )
                idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])

                store.create_collection(f"kb_{kb_idx}", dimension, metric)

                def batch_iter():
                    bs = 10_000
                    for start in range(0, len(dataset.vectors), bs):
                        end = min(start + bs, len(dataset.vectors))
                        yield (
                            dataset.vectors[start:end],
                            dataset.metadata[start:end],
                            dataset.texts[start:end],
                        )

                insert_metrics = store.insert_batch(batch_iter(), vectors_per_kb)
                store.create_index(idx_type, **idx_params)
                insert_times.append(insert_metrics.elapsed_seconds)

                if kb_idx % 10 == 0:
                    logger.info("  Created KB %d/%d", kb_idx + 1, n_kbs)

            mem_after_all = stores[0].get_memory_usage_bytes() / (1024 * 1024)

            cold_latencies = []
            warm_latencies = []
            for kb_idx, store in enumerate(stores):
                qvec = query_dataset.queries[kb_idx % len(query_dataset.queries)]

                start = time.perf_counter()
                store.vector_search(qvec, top_k=top_k)
                cold_latencies.append((time.perf_counter() - start) * 1000)

                start = time.perf_counter()
                store.vector_search(qvec, top_k=top_k)
                warm_latencies.append((time.perf_counter() - start) * 1000)

            cross_kb_latencies = []
            for q_idx in range(min(20, len(query_dataset.queries))):
                qvec = query_dataset.queries[q_idx]
                all_results = []
                start = time.perf_counter()
                for store in stores[:min(5, n_kbs)]:
                    r = store.vector_search(qvec, top_k=top_k)
                    all_results.extend(r.results)
                all_results.sort(key=lambda x: x.score)
                cross_kb_latencies.append((time.perf_counter() - start) * 1000)

            cold_stats = mc.compute_latency(cold_latencies)
            warm_stats = mc.compute_latency(warm_latencies)
            cross_stats = mc.compute_latency(cross_kb_latencies)

            result = BenchmarkResult(
                scenario="multi_kb",
                store_type=store_type,
                index_type=INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])[0],
                params={"num_kbs": n_kbs, "vectors_per_kb": vectors_per_kb},
                latency=warm_stats,
                peak_memory_mb=mem_after_all,
                extra={
                    "cold_start_p50_ms": round(cold_stats.p50_ms, 3),
                    "cold_start_p99_ms": round(cold_stats.p99_ms, 3),
                    "warm_p50_ms": round(warm_stats.p50_ms, 3),
                    "warm_p99_ms": round(warm_stats.p99_ms, 3),
                    "cross_kb_p50_ms": round(cross_stats.p50_ms, 3),
                    "avg_insert_seconds": round(np.mean(insert_times), 2),
                },
            )

            from harness.runner import BenchmarkRunner
            runner = BenchmarkRunner(stores[0], store_type, output_dir)
            runner._save_result(result, suffix=f"{n_kbs}kbs")
            results.append(result)

        except Exception:
            logger.exception("Failed: multi_kb %d KBs", n_kbs)
        finally:
            for store in stores:
                try:
                    store.drop_collection()
                    store.close()
                except Exception:
                    pass

    return results
