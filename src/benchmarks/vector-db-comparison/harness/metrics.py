"""Metrics collection and computation for vector DB benchmarks."""

import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import psutil


@dataclass
class LatencyStats:
    p50_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    mean_ms: float = 0.0
    min_ms: float = 0.0
    max_ms: float = 0.0
    count: int = 0


@dataclass
class QualityMetrics:
    recall_at_1: float = 0.0
    recall_at_5: float = 0.0
    recall_at_10: float = 0.0
    recall_at_50: float = 0.0
    ndcg_at_10: float = 0.0
    mrr: float = 0.0


@dataclass
class BenchmarkResult:
    scenario: str = ""
    store_type: str = ""
    index_type: str = ""
    params: dict = field(default_factory=dict)
    quality: Optional[QualityMetrics] = None
    latency: Optional[LatencyStats] = None
    qps: float = 0.0
    insert_throughput: float = 0.0
    index_build_seconds: float = 0.0
    index_size_mb: float = 0.0
    peak_memory_mb: float = 0.0
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "scenario": self.scenario,
            "store_type": self.store_type,
            "index_type": self.index_type,
            "params": self.params,
            "qps": round(self.qps, 2),
            "insert_throughput": round(self.insert_throughput, 2),
            "index_build_seconds": round(self.index_build_seconds, 3),
            "index_size_mb": round(self.index_size_mb, 2),
            "peak_memory_mb": round(self.peak_memory_mb, 2),
        }
        if self.quality:
            d["quality"] = {
                "recall@1": round(self.quality.recall_at_1, 4),
                "recall@5": round(self.quality.recall_at_5, 4),
                "recall@10": round(self.quality.recall_at_10, 4),
                "recall@50": round(self.quality.recall_at_50, 4),
                "ndcg@10": round(self.quality.ndcg_at_10, 4),
                "mrr": round(self.quality.mrr, 4),
            }
        if self.latency:
            d["latency"] = {
                "p50_ms": round(self.latency.p50_ms, 3),
                "p95_ms": round(self.latency.p95_ms, 3),
                "p99_ms": round(self.latency.p99_ms, 3),
                "mean_ms": round(self.latency.mean_ms, 3),
            }
        if self.extra:
            d["extra"] = self.extra
        return d


class MetricsCollector:
    """Utilities for collecting benchmark metrics."""

    @staticmethod
    def compute_latency(latencies_ms: list[float]) -> LatencyStats:
        if not latencies_ms:
            return LatencyStats()
        arr = np.array(latencies_ms)
        return LatencyStats(
            p50_ms=float(np.percentile(arr, 50)),
            p95_ms=float(np.percentile(arr, 95)),
            p99_ms=float(np.percentile(arr, 99)),
            mean_ms=float(np.mean(arr)),
            min_ms=float(np.min(arr)),
            max_ms=float(np.max(arr)),
            count=len(latencies_ms),
        )

    @staticmethod
    def compute_recall(retrieved_ids: list[list], ground_truth_ids: list[list], k: int) -> float:
        """Recall@k: fraction of true neighbors found in top-k results."""
        if not retrieved_ids:
            return 0.0
        recalls = []
        for retrieved, truth in zip(retrieved_ids, ground_truth_ids):
            truth_set = set(truth[:k])
            found = len(truth_set & set(retrieved[:k]))
            recalls.append(found / max(len(truth_set), 1))
        return float(np.mean(recalls))

    @staticmethod
    def compute_ndcg(retrieved_ids: list[list], ground_truth_ids: list[list], k: int) -> float:
        """NDCG@k with binary relevance (1 if in ground truth, 0 otherwise)."""
        if not retrieved_ids:
            return 0.0
        ndcgs = []
        for retrieved, truth in zip(retrieved_ids, ground_truth_ids):
            truth_set = set(truth[:k])
            dcg = sum(
                (1.0 / np.log2(i + 2)) for i, rid in enumerate(retrieved[:k]) if rid in truth_set
            )
            ideal_dcg = sum(1.0 / np.log2(i + 2) for i in range(min(len(truth_set), k)))
            ndcgs.append(dcg / ideal_dcg if ideal_dcg > 0 else 0.0)
        return float(np.mean(ndcgs))

    @staticmethod
    def compute_mrr(retrieved_ids: list[list], ground_truth_ids: list[list]) -> float:
        """Mean Reciprocal Rank: average of 1/rank of first relevant result."""
        if not retrieved_ids:
            return 0.0
        rrs = []
        for retrieved, truth in zip(retrieved_ids, ground_truth_ids):
            truth_set = set(truth)
            rr = 0.0
            for i, rid in enumerate(retrieved):
                if rid in truth_set:
                    rr = 1.0 / (i + 1)
                    break
            rrs.append(rr)
        return float(np.mean(rrs))

    @staticmethod
    def compute_quality(
        retrieved_ids: list[list], ground_truth_ids: list[list]
    ) -> QualityMetrics:
        mc = MetricsCollector
        return QualityMetrics(
            recall_at_1=mc.compute_recall(retrieved_ids, ground_truth_ids, 1),
            recall_at_5=mc.compute_recall(retrieved_ids, ground_truth_ids, 5),
            recall_at_10=mc.compute_recall(retrieved_ids, ground_truth_ids, 10),
            recall_at_50=mc.compute_recall(retrieved_ids, ground_truth_ids, 50),
            ndcg_at_10=mc.compute_ndcg(retrieved_ids, ground_truth_ids, 10),
            mrr=mc.compute_mrr(retrieved_ids, ground_truth_ids),
        )

    @staticmethod
    def get_memory_mb() -> float:
        proc = psutil.Process()
        return proc.memory_info().rss / (1024 * 1024)

    @staticmethod
    def time_it():
        """Context-manager-style timer. Usage: start = time.perf_counter() ... elapsed."""
        return time.perf_counter()
