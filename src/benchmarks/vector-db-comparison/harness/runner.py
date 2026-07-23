"""Test scenario orchestrator for vector DB benchmarks."""

import json
import logging
import time
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import numpy as np
import yaml

from harness.base import VectorStore
from harness.datasets import Dataset, generate_synthetic
from harness.metrics import BenchmarkResult, MetricsCollector

logger = logging.getLogger(__name__)


class BenchmarkRunner:
    """Orchestrates benchmark scenarios against a VectorStore implementation."""

    def __init__(self, store: VectorStore, store_type: str, output_dir: str = "./results"):
        self.store = store
        self.store_type = store_type
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.mc = MetricsCollector()

    def _save_result(self, result: BenchmarkResult, suffix: str = ""):
        filename = f"{result.scenario}_{self.store_type}"
        if suffix:
            filename += f"_{suffix}"
        filename += ".json"
        path = self.output_dir / filename
        with open(path, "w") as f:
            json.dump(result.to_dict(), f, indent=2)
        logger.info("Saved result: %s", path)

    def run_insert_and_index(
        self,
        dataset: Dataset,
        collection_name: str,
        index_type: str,
        metric: str = "cosine",
        batch_size: int = 10000,
        **index_params,
    ) -> tuple[float, float]:
        """Insert data and build index. Returns (insert_seconds, index_build_seconds)."""
        self.store.create_collection(collection_name, dataset.dimension, metric)

        def batch_iter():
            for start in range(0, len(dataset.vectors), batch_size):
                end = min(start + batch_size, len(dataset.vectors))
                yield (
                    dataset.vectors[start:end],
                    dataset.metadata[start:end],
                    dataset.texts[start:end],
                )

        insert_metrics = self.store.insert_batch(batch_iter(), len(dataset.vectors))
        logger.info(
            "Inserted %d vectors in %.2fs (%.0f vec/s)",
            insert_metrics.count,
            insert_metrics.elapsed_seconds,
            insert_metrics.vectors_per_second,
        )

        index_build_time = self.store.create_index(index_type, **index_params)
        logger.info("Built %s index in %.2fs", index_type, index_build_time)

        return insert_metrics.elapsed_seconds, index_build_time

    def run_query_benchmark(
        self,
        dataset: Dataset,
        top_k: int = 10,
        num_queries: Optional[int] = None,
    ) -> BenchmarkResult:
        """Run vector search queries and compute quality + latency metrics."""
        queries = dataset.queries
        if num_queries and num_queries < len(queries):
            queries = queries[:num_queries]

        latencies = []
        retrieved_ids = []

        for qvec in queries:
            result = self.store.vector_search(qvec, top_k=top_k)
            latencies.append(result.latency_ms)
            retrieved_ids.append([r.id for r in result.results])

        gt_k = min(top_k, dataset.ground_truth.shape[1]) if dataset.ground_truth.ndim > 1 else top_k
        gt = [list(row[:gt_k]) for row in dataset.ground_truth[: len(queries)]]

        quality = self.mc.compute_quality(retrieved_ids, gt)
        latency_stats = self.mc.compute_latency(latencies)
        total_time = sum(latencies) / 1000
        qps = len(queries) / total_time if total_time > 0 else 0

        return BenchmarkResult(
            quality=quality,
            latency=latency_stats,
            qps=qps,
            index_size_mb=self.store.get_index_size_bytes() / (1024 * 1024),
            peak_memory_mb=self.store.get_memory_usage_bytes() / (1024 * 1024),
        )

    def run_fts_benchmark(
        self,
        queries: list[str],
        ground_truth_ids: list[list],
        top_k: int = 10,
    ) -> BenchmarkResult:
        """Run FTS queries and compute latency."""
        latencies = []
        retrieved_ids = []

        for q in queries:
            result = self.store.fts_search(q, top_k=top_k)
            latencies.append(result.latency_ms)
            retrieved_ids.append([r.id for r in result.results])

        quality = self.mc.compute_quality(retrieved_ids, ground_truth_ids) if ground_truth_ids else None
        latency_stats = self.mc.compute_latency(latencies)
        total_time = sum(latencies) / 1000
        qps = len(queries) / total_time if total_time > 0 else 0

        return BenchmarkResult(quality=quality, latency=latency_stats, qps=qps)

    def run_hybrid_benchmark(
        self,
        query_vectors: np.ndarray,
        query_texts: list[str],
        ground_truth_ids: list[list],
        top_k: int = 10,
    ) -> BenchmarkResult:
        """Run hybrid (vector + FTS) queries."""
        latencies = []
        retrieved_ids = []

        for qvec, qtext in zip(query_vectors, query_texts):
            result = self.store.hybrid_search(qvec, qtext, top_k=top_k)
            latencies.append(result.latency_ms)
            retrieved_ids.append([r.id for r in result.results])

        quality = self.mc.compute_quality(retrieved_ids, ground_truth_ids)
        latency_stats = self.mc.compute_latency(latencies)
        total_time = sum(latencies) / 1000
        qps = len(query_vectors) / total_time if total_time > 0 else 0

        return BenchmarkResult(quality=quality, latency=latency_stats, qps=qps)
