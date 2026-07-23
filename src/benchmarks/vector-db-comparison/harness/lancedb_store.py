"""LanceDB implementation backed by a mounted POSIX filesystem."""

import json
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Iterator, Optional

import lancedb
import numpy as np
import psutil

from harness.base import (
    BackupMetrics,
    InsertMetrics,
    SearchResult,
    SearchResults,
    VectorStore,
    VersionSwitchMetrics,
)

logger = logging.getLogger(__name__)


class LanceDBStore(VectorStore):
    """LanceDB on a shared mounted filesystem (NFS / EFS / local volume)."""

    TABLE_NAME = "kb_vectors"

    def __init__(self, data_dir: str = "/mnt/kbs"):
        self._data_dir = Path(data_dir)
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._db = None
        self._table = None
        self._collection_name: Optional[str] = None
        self._dimension: int = 0
        self._metric: str = "cosine"
        self._current_version: Optional[str] = None
        self._versions: dict[str, str] = {}
        self._nprobes: Optional[int] = None

    def _collection_dir(self, name: Optional[str] = None) -> Path:
        return self._data_dir / (name or self._collection_name or "default")

    def create_collection(self, name: str, dimension: int, metric: str = "cosine") -> None:
        self._collection_name = name
        self._dimension = dimension
        self._metric = metric
        self._nprobes = None
        self._versions = {}
        self._current_version = None
        db_path = self._collection_dir()
        if db_path.exists() or db_path.is_symlink():
            if db_path.is_symlink() or db_path.is_file():
                db_path.unlink()
            else:
                shutil.rmtree(db_path)
        db_path.mkdir(parents=True, exist_ok=True)
        self._db = lancedb.connect(str(db_path))
        existing = self._db.table_names()
        if self.TABLE_NAME in existing:
            self._db.drop_table(self.TABLE_NAME)
        self._table = None

    def _lance_distance_metric(self) -> str:
        m = (self._metric or "cosine").lower()
        if m in ("l2", "euclidean"):
            return "l2"
        if m in ("dot", "ip", "inner_product"):
            return "dot"
        return "cosine"

    def create_index(self, index_type: str, **params) -> float:
        if self._table is None:
            raise RuntimeError("No data inserted yet; cannot build index")
        start = time.perf_counter()
        if index_type == "flat":
            self._nprobes = None
        elif index_type in ("ivfflat", "ivf_flat"):
            m = self._lance_distance_metric()
            num_partitions = params.get("num_partitions", params.get("lists", 100))
            self._nprobes = int(params.get("probes", 10))
            self._table.create_index(
                metric=m,
                num_partitions=int(num_partitions),
                index_type="IVF_FLAT",
            )
        elif index_type.startswith("ivf_pq"):
            m = self._lance_distance_metric()
            num_partitions = params.get("num_partitions", 256)
            num_sub_vectors = params.get("num_sub_vectors", 96)
            self._nprobes = int(params["probes"]) if "probes" in params else None
            self._table.create_index(
                metric=m,
                num_partitions=num_partitions,
                num_sub_vectors=num_sub_vectors,
                index_type="IVF_PQ",
            )
        else:
            self._nprobes = None
            logger.warning("Unknown index type %s, skipping index creation", index_type)
        # FTS for hybrid/keyword search (Lance Tantivy BM25)
        try:
            self._table.create_fts_index("text")
        except Exception as e:
            logger.debug("FTS index: %s", e)
        elapsed = time.perf_counter() - start
        return elapsed

    def insert(self, vectors, metadata: list[dict], texts: list[str]) -> InsertMetrics:
        mem_before = psutil.Process().memory_info().rss
        start = time.perf_counter()

        records = []
        for i, (vec, meta, text) in enumerate(zip(vectors, metadata, texts)):
            record = {
                "id": meta.get("id", i),
                "vector": vec.tolist() if hasattr(vec, "tolist") else list(vec),
                "text": text,
            }
            record.update(meta)
            records.append(record)

        if self._table is None:
            self._table = self._db.create_table(self.TABLE_NAME, records)
        else:
            self._table.add(records)

        elapsed = time.perf_counter() - start
        mem_after = psutil.Process().memory_info().rss
        count = len(vectors)
        return InsertMetrics(
            count=count,
            elapsed_seconds=elapsed,
            vectors_per_second=count / elapsed if elapsed > 0 else 0,
            peak_memory_mb=(mem_after - mem_before) / (1024 * 1024),
        )

    def insert_batch(self, batches: Iterator, total_count: int) -> InsertMetrics:
        mem_before = psutil.Process().memory_info().rss
        start = time.perf_counter()
        inserted = 0

        for batch_vectors, batch_metadata, batch_texts in batches:
            records = []
            for i, (vec, meta, text) in enumerate(zip(batch_vectors, batch_metadata, batch_texts)):
                record = {
                    "id": meta.get("id", inserted + i),
                    "vector": vec.tolist() if hasattr(vec, "tolist") else list(vec),
                    "text": text,
                }
                record.update(meta)
                records.append(record)

            if self._table is None:
                self._table = self._db.create_table(self.TABLE_NAME, records)
            else:
                self._table.add(records)
            inserted += len(batch_vectors)

        elapsed = time.perf_counter() - start
        mem_after = psutil.Process().memory_info().rss
        return InsertMetrics(
            count=inserted,
            elapsed_seconds=elapsed,
            vectors_per_second=inserted / elapsed if elapsed > 0 else 0,
            peak_memory_mb=(mem_after - mem_before) / (1024 * 1024),
        )

    def vector_search(
        self, query_vector, top_k: int = 10, filters: Optional[dict] = None
    ) -> SearchResults:
        if self._table is None:
            return SearchResults()
        qvec = query_vector.tolist() if hasattr(query_vector, "tolist") else list(query_vector)
        start = time.perf_counter()

        query = self._table.search(qvec).metric(self._lance_distance_metric()).limit(top_k)
        if self._nprobes is not None:
            query = query.nprobes(self._nprobes)
        if filters:
            where_clauses = []
            for key, value in filters.items():
                if isinstance(value, str):
                    where_clauses.append(f"{key} = '{value}'")
                else:
                    where_clauses.append(f"{key} = {value}")
            query = query.where(" AND ".join(where_clauses))

        rows = query.to_list()
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = [
            SearchResult(
                id=row.get("id"),
                score=row.get("_distance", 0.0),
                text=row.get("text", ""),
                metadata={k: v for k, v in row.items() if k not in ("id", "vector", "text", "_distance")},
            )
            for row in rows
        ]
        return SearchResults(results=results, latency_ms=elapsed_ms)

    def fts_search(self, query_text: str, top_k: int = 10) -> SearchResults:
        if self._table is None:
            return SearchResults()
        start = time.perf_counter()
        rows = self._table.search(query_text, query_type="fts").limit(top_k).to_list()
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = [
            SearchResult(
                id=row.get("id"),
                score=row.get("_score", 0.0),
                text=row.get("text", ""),
                metadata={k: v for k, v in row.items() if k not in ("id", "vector", "text", "_score")},
            )
            for row in rows
        ]
        return SearchResults(results=results, latency_ms=elapsed_ms)

    def hybrid_search(self, query_vector, query_text: str, top_k: int = 10) -> SearchResults:
        if self._table is None:
            return SearchResults()
        qvec = query_vector.tolist() if hasattr(query_vector, "tolist") else list(query_vector)
        start = time.perf_counter()
        m = self._lance_distance_metric()
        try:
            from lancedb.rerankers import RRFReranker

            q = (
                self._table.search(query_type="hybrid")
                .vector(qvec)
                .text(query_text)
                .metric(m)
                .limit(top_k)
            )
            if self._nprobes is not None:
                q = q.nprobes(self._nprobes)
            rows = q.rerank(reranker=RRFReranker()).to_list()
        except Exception as e:
            logger.debug("Hybrid search fallback: %s", e)
            q2 = self._table.search(qvec).metric(m).limit(top_k)
            if self._nprobes is not None:
                q2 = q2.nprobes(self._nprobes)
            rows = q2.to_list()
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = [
            SearchResult(
                id=row.get("id"),
                score=row.get("_relevance_score", row.get("_distance", 0.0)),
                text=row.get("text", ""),
                metadata={
                    k: v
                    for k, v in row.items()
                    if k not in ("id", "vector", "text", "_distance", "_relevance_score", "_score")
                },
            )
            for row in rows
        ]
        return SearchResults(results=results, latency_ms=elapsed_ms)

    def count(self) -> int:
        if self._table is None:
            return 0
        return self._table.count_rows()

    def clear_for_reingest(self) -> None:
        if self._db and self._table is not None:
            try:
                self._db.drop_table(self.TABLE_NAME)
            except Exception:
                pass
        self._table = None

    def drop_collection(self) -> None:
        if self._db and self._table:
            try:
                self._db.drop_table(self.TABLE_NAME)
            except Exception:
                pass
        self._table = None

    def get_index_size_bytes(self) -> int:
        cdir = self._collection_dir()
        if not cdir.exists():
            return 0
        total = 0
        for f in cdir.rglob("*"):
            if f.is_file():
                total += f.stat().st_size
        return total

    def get_memory_usage_bytes(self) -> int:
        return psutil.Process().memory_info().rss

    def create_version(self, version_id: str) -> None:
        """Create a blue-green version by copying the current collection directory."""
        src = self._collection_dir()
        dst = self._data_dir / f"{self._collection_name}-{version_id}"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        self._versions[version_id] = str(dst)

        meta_path = self._data_dir / f"{self._collection_name}-metadata.json"
        meta = {"active_version": version_id, "versions": self._versions}
        meta_path.write_text(json.dumps(meta))

    def switch_version(self, version_id: str) -> VersionSwitchMetrics:
        start = time.perf_counter()
        if version_id not in self._versions:
            raise ValueError(f"Version {version_id} not found")

        version_dir = self._versions[version_id]
        symlink = self._collection_dir()
        actual_dir = self._data_dir / f"{self._collection_name}-active"

        if symlink.is_symlink():
            symlink.unlink()
        elif symlink.is_dir():
            if actual_dir.exists():
                if actual_dir.is_symlink():
                    actual_dir.unlink()
                else:
                    shutil.rmtree(actual_dir)
            symlink.rename(actual_dir)

        symlink.symlink_to(version_dir)

        self._db = lancedb.connect(str(version_dir))
        self._table = self._db.open_table(self.TABLE_NAME)
        self._current_version = version_id

        elapsed_ms = (time.perf_counter() - start) * 1000

        q = np.zeros(self._dimension, dtype=np.float32) + 1e-5
        qbuild = self._table.search(
            q.tolist() if hasattr(q, "tolist") else list(q)
        ).metric(self._lance_distance_metric()).limit(1)
        if self._nprobes is not None:
            qbuild = qbuild.nprobes(self._nprobes)
        probe_result = qbuild.to_list()
        verified = len(probe_result) > 0

        return VersionSwitchMetrics(
            switch_latency_ms=elapsed_ms,
            version_id=version_id,
            verified_correct=verified,
        )

    def list_versions(self) -> list[str]:
        return list(self._versions.keys())

    def backup(self, target_path: str) -> BackupMetrics:
        src = self._collection_dir()
        start = time.perf_counter()
        if os.path.exists(target_path):
            shutil.rmtree(target_path)
        shutil.copytree(src, target_path)
        elapsed = time.perf_counter() - start

        total_size = sum(f.stat().st_size for f in Path(target_path).rglob("*") if f.is_file())
        return BackupMetrics(
            elapsed_seconds=elapsed,
            size_mb=total_size / (1024 * 1024),
            path=target_path,
        )

    def restore(self, source_path: str) -> BackupMetrics:
        dst = self._collection_dir()
        start = time.perf_counter()
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(source_path, dst)

        self._db = lancedb.connect(str(dst))
        self._table = self._db.open_table(self.TABLE_NAME)
        elapsed = time.perf_counter() - start

        total_size = sum(f.stat().st_size for f in dst.rglob("*") if f.is_file())
        return BackupMetrics(
            elapsed_seconds=elapsed,
            size_mb=total_size / (1024 * 1024),
            path=str(dst),
        )

    def close(self) -> None:
        self._table = None
        self._db = None
