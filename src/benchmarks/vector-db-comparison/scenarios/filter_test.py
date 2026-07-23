"""Scenario 5: Filtered Search -- metadata filtering with vector search.

Tests categorical metadata with 10, 100, 1000 distinct values.
Measures pre-filter vs post-filter behavior and impact on latency/recall.
"""

import logging

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
    cardinalities: list[int] | None = None,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    cardinalities = cardinalities or [10, 100, 1000]
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    mc = MetricsCollector()
    results = []

    for cardinality in cardinalities:
        dataset = generate_synthetic(count, dimension, num_queries=200, k=50, categories=cardinality)
        label = f"filter_card{cardinality}"
        logger.info("=== Filter Test: %s, cardinality=%d ===", store_type, cardinality)

        try:
            runner.run_insert_and_index(dataset, label, idx_type, metric, **idx_params)

            latencies_unfiltered = []
            latencies_filtered = []
            retrieved_unfiltered = []
            retrieved_filtered = []

            for i, qvec in enumerate(dataset.queries[:200]):
                r_unf = store.vector_search(qvec, top_k=top_k)
                latencies_unfiltered.append(r_unf.latency_ms)
                retrieved_unfiltered.append([r.id for r in r_unf.results])

                target_cat = f"cat_{i % cardinality}"
                r_fil = store.vector_search(qvec, top_k=top_k, filters={"category": target_cat})
                latencies_filtered.append(r_fil.latency_ms)
                retrieved_filtered.append([r.id for r in r_fil.results])

            gt = [list(row) for row in dataset.ground_truth[:200]]

            unf_lat = mc.compute_latency(latencies_unfiltered)
            fil_lat = mc.compute_latency(latencies_filtered)
            unf_quality = mc.compute_quality(retrieved_unfiltered, gt)

            unf_result = BenchmarkResult(
                scenario="filter",
                store_type=store_type,
                index_type=idx_type,
                params={"cardinality": cardinality, "filtered": False, "count": count},
                quality=unf_quality,
                latency=unf_lat,
                qps=200 / (sum(latencies_unfiltered) / 1000) if sum(latencies_unfiltered) > 0 else 0,
            )
            runner._save_result(unf_result, suffix=f"card{cardinality}_unfiltered")
            results.append(unf_result)

            fil_result = BenchmarkResult(
                scenario="filter",
                store_type=store_type,
                index_type=idx_type,
                params={"cardinality": cardinality, "filtered": True, "count": count},
                latency=fil_lat,
                qps=200 / (sum(latencies_filtered) / 1000) if sum(latencies_filtered) > 0 else 0,
                extra={"latency_overhead_pct": round(
                    ((fil_lat.p50_ms - unf_lat.p50_ms) / unf_lat.p50_ms * 100)
                    if unf_lat.p50_ms > 0 else 0, 2
                )},
            )
            runner._save_result(fil_result, suffix=f"card{cardinality}_filtered")
            results.append(fil_result)

        except Exception:
            logger.exception("Failed: %s", label)
        finally:
            store.drop_collection()

    return results
