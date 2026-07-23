"""Scenario 8: Versioning and Rollback -- blue-green style snapshots and switch time."""

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
    num_versions: list[int] | None = None,
    metric: str = "cosine",
    top_k: int = 10,
) -> list[BenchmarkResult]:
    # Default to [2] for practical CI/local runs; use [2,5,10] in full study.
    num_versions = num_versions or [2]
    runner = BenchmarkRunner(store, store_type, output_dir)
    idx_type, idx_params = INDEX_CONFIGS.get(store_type, INDEX_CONFIGS["lancedb"])
    mc = MetricsCollector()
    results = []

    for n_v in num_versions:
        if n_v < 2:
            continue
        logger.info("=== Versioning Test: %s, N=%d versions ===", store_type, n_v)

        try:
            d1 = generate_synthetic(count, dimension, num_queries=50, k=50, seed=42)
            ins_sec, b_sec = runner.run_insert_and_index(
                d1, "versioning", idx_type, metric, **idx_params
            )
            s1 = store.get_index_size_bytes()
            store.create_version("v1")
            s_after_v1 = store.get_index_size_bytes()

            switch_latencies: list[float] = []

            for v_idx in range(2, n_v + 1):
                store.clear_for_reingest()
                d_new = generate_synthetic(
                    count, dimension, num_queries=50, k=50, seed=42 + v_idx
                )

                def batches():
                    batch = 10_000
                    for s in range(0, count, batch):
                        e = min(s + batch, count)
                        yield d_new.vectors[s:e], d_new.metadata[s:e], d_new.texts[s:e]

                _ = store.insert_batch(batches(), count)
                store.create_index(idx_type, **idx_params)
                store.create_version(f"v{v_idx}")

                sw = store.switch_version("v1")
                switch_latencies.append(sw.switch_latency_ms)
                sw2 = store.switch_version(f"v{v_idx}")
                switch_latencies.append(sw2.switch_latency_ms)
                logger.info("  v1 switch %.2fms, v%dswitch %.2fms", sw.switch_latency_ms, v_idx, sw2.switch_latency_ms)

            rb = store.switch_version("v1")
            _ = store.vector_search(d1.queries[0], top_k=1)

            st = mc.compute_latency(switch_latencies) if switch_latencies else None
            overhead = (
                ((s_after_v1 - s1) / s1 * 100) if s1 and s_after_v1 else 0.0
            )

            result = BenchmarkResult(
                scenario="versioning",
                store_type=store_type,
                index_type=idx_type,
                params={
                    "num_versions": n_v,
                    "count": count,
                    "first_insert_s": round(ins_sec, 3),
                    "first_index_s": round(b_sec, 3),
                },
                latency=st,
                index_size_mb=store.get_index_size_bytes() / (1024 * 1024),
                insert_throughput=count / ins_sec if ins_sec else 0,
                index_build_seconds=b_sec,
                extra={
                    "rollback_last_switch_ms": round(rb.switch_latency_ms, 3),
                    "version_dirs_bytes_overhead_pct": round(overhead, 1),
                    "versions": store.list_versions(),
                },
            )
            runner._save_result(result, suffix=f"{n_v}v")
            results.append(result)

        except Exception:
            logger.exception("Versioning test failed: %s n=%d", store_type, n_v)
        finally:
            store.drop_collection()

    return results
