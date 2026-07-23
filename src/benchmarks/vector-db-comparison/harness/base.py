"""Abstract VectorStore interface for apples-to-apples comparison."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional


@dataclass
class InsertMetrics:
    count: int = 0
    elapsed_seconds: float = 0.0
    vectors_per_second: float = 0.0
    peak_memory_mb: float = 0.0


@dataclass
class SearchResult:
    id: Any = None
    score: float = 0.0
    text: str = ""
    metadata: dict = field(default_factory=dict)


@dataclass
class SearchResults:
    results: list[SearchResult] = field(default_factory=list)
    latency_ms: float = 0.0


@dataclass
class VersionSwitchMetrics:
    switch_latency_ms: float = 0.0
    version_id: str = ""
    verified_correct: bool = False


@dataclass
class BackupMetrics:
    elapsed_seconds: float = 0.0
    size_mb: float = 0.0
    path: str = ""


class VectorStore(ABC):
    """Common interface implemented by LanceDB and pgvector backends."""

    @abstractmethod
    def create_collection(self, name: str, dimension: int, metric: str = "cosine") -> None:
        """Create a new vector collection/table."""

    @abstractmethod
    def create_index(self, index_type: str, **params) -> float:
        """Create an ANN index. Returns build time in seconds."""

    @abstractmethod
    def insert(self, vectors, metadata: list[dict], texts: list[str]) -> InsertMetrics:
        """Insert vectors with associated metadata and text content."""

    @abstractmethod
    def insert_batch(self, batches: Iterator, total_count: int) -> InsertMetrics:
        """Insert vectors in streaming batches for memory efficiency."""

    @abstractmethod
    def vector_search(
        self,
        query_vector,
        top_k: int = 10,
        filters: Optional[dict] = None,
    ) -> SearchResults:
        """Nearest-neighbor vector search with optional metadata filters."""

    @abstractmethod
    def fts_search(self, query_text: str, top_k: int = 10) -> SearchResults:
        """Full-text keyword search."""

    @abstractmethod
    def hybrid_search(
        self,
        query_vector,
        query_text: str,
        top_k: int = 10,
    ) -> SearchResults:
        """Combined vector + FTS search with RRF merging."""

    @abstractmethod
    def count(self) -> int:
        """Return total number of vectors in the collection."""

    @abstractmethod
    def drop_collection(self) -> None:
        """Drop the current collection and free resources."""

    @abstractmethod
    def get_index_size_bytes(self) -> int:
        """Return the size of the index on disk in bytes."""

    @abstractmethod
    def get_memory_usage_bytes(self) -> int:
        """Return current process memory usage in bytes."""

    @abstractmethod
    def create_version(self, version_id: str) -> None:
        """Create a named snapshot/version of the current data."""

    @abstractmethod
    def switch_version(self, version_id: str) -> VersionSwitchMetrics:
        """Switch the active serving version. Returns switch metrics."""

    @abstractmethod
    def list_versions(self) -> list[str]:
        """List all available version identifiers."""

    @abstractmethod
    def backup(self, target_path: str) -> BackupMetrics:
        """Create a full backup at target_path."""

    @abstractmethod
    def restore(self, source_path: str) -> BackupMetrics:
        """Restore from a backup at source_path. Returns restore metrics."""

    def clear_for_reingest(self) -> None:
        """Remove all rows to load a new dataset version; keep version snapshots."""
        pass

    @abstractmethod
    def close(self) -> None:
        """Release all resources held by this store."""
