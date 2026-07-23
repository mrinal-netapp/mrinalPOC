"""Dataset loading and ground-truth generation for vector DB benchmarks.

Supports standard ANN benchmark datasets (SIFT, GloVe) and synthetic data.
"""

import logging
import os
import tarfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import h5py
import numpy as np

logger = logging.getLogger(__name__)

SIFT_URL = "ftp://ftp.irisa.fr/local/texmex/corpus/sift.tar.gz"
GLOVE_URL = "https://huggingface.co/api/datasets/mteb/glove-200-angular/parquet/default/test/0.parquet"


@dataclass
class Dataset:
    name: str
    vectors: np.ndarray
    queries: np.ndarray
    ground_truth: np.ndarray  # shape (num_queries, k) with row indices
    texts: list[str] = field(default_factory=list)
    metadata: list[dict] = field(default_factory=list)
    dimension: int = 0

    def __post_init__(self):
        self.dimension = self.vectors.shape[1] if len(self.vectors.shape) > 1 else 0


def generate_synthetic(
    count: int,
    dimension: int,
    num_queries: int = 200,
    k: int = 50,
    seed: int = 42,
    categories: int = 0,
) -> Dataset:
    """Generate random vectors with brute-force ground truth."""
    rng = np.random.default_rng(seed)
    vectors = rng.standard_normal((count, dimension)).astype(np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vectors = vectors / norms

    queries = rng.standard_normal((num_queries, dimension)).astype(np.float32)
    query_norms = np.linalg.norm(queries, axis=1, keepdims=True)
    query_norms[query_norms == 0] = 1.0
    queries = queries / query_norms

    logger.info("Computing brute-force ground truth for %d queries against %d vectors...", num_queries, count)
    similarities = queries @ vectors.T
    ground_truth = np.argsort(-similarities, axis=1)[:, :k]

    texts = [f"Document {i}" for i in range(count)]
    metadata = [{"id": i} for i in range(count)]
    if categories > 0:
        cat_labels = [f"cat_{i % categories}" for i in range(count)]
        for i, m in enumerate(metadata):
            m["category"] = cat_labels[i]

    return Dataset(
        name=f"synthetic_{count}_{dimension}d",
        vectors=vectors,
        queries=queries,
        ground_truth=ground_truth,
        texts=texts,
        metadata=metadata,
    )


def generate_content_types(
    count_per_type: int = 5000,
    dimension: int = 384,
    num_queries: int = 50,
    k: int = 50,
    seed: int = 42,
) -> dict[str, Dataset]:
    """Generate datasets with different simulated content types."""
    rng = np.random.default_rng(seed)
    datasets = {}

    type_configs = {
        "plain_text": {"prefix": "The quick brown fox jumped over the lazy dog. Document number"},
        "structured": {"prefix": '{"name": "row", "value":'},
        "code": {"prefix": "def function_"},
        "mixed": {"prefix": "Mixed content document"},
    }

    for content_type, cfg in type_configs.items():
        vectors = rng.standard_normal((count_per_type, dimension)).astype(np.float32)
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        vectors = vectors / norms

        queries = rng.standard_normal((num_queries, dimension)).astype(np.float32)
        query_norms = np.linalg.norm(queries, axis=1, keepdims=True)
        query_norms[query_norms == 0] = 1.0
        queries = queries / query_norms

        similarities = queries @ vectors.T
        ground_truth = np.argsort(-similarities, axis=1)[:, :k]

        texts = [f"{cfg['prefix']} {i}" for i in range(count_per_type)]
        metadata = [{"id": i, "content_type": content_type} for i in range(count_per_type)]

        datasets[content_type] = Dataset(
            name=f"content_{content_type}",
            vectors=vectors,
            queries=queries,
            ground_truth=ground_truth,
            texts=texts,
            metadata=metadata,
        )

    return datasets


def load_sift(cache_dir: str = "./data", max_count: Optional[int] = None) -> Dataset:
    """Load SIFT-128 benchmark dataset (1M vectors, 128d)."""
    cache_path = Path(cache_dir)
    cache_path.mkdir(parents=True, exist_ok=True)
    sift_dir = cache_path / "sift"

    if not sift_dir.exists():
        tar_path = cache_path / "sift.tar.gz"
        if not tar_path.exists():
            logger.info("Downloading SIFT dataset...")
            urllib.request.urlretrieve(SIFT_URL, str(tar_path))
        logger.info("Extracting SIFT dataset...")
        with tarfile.open(str(tar_path), "r:gz") as tf:
            tf.extractall(str(cache_path))

    def read_fvecs(path: str) -> np.ndarray:
        with open(path, "rb") as f:
            data = np.fromfile(f, dtype=np.int32, count=1)
            dim = data[0]
            f.seek(0)
            n_bytes = os.path.getsize(path)
            n_vecs = n_bytes // (4 + dim * 4)
            data = np.fromfile(f, dtype=np.float32).reshape(n_vecs, dim + 1)
            return data[:, 1:]

    def read_ivecs(path: str) -> np.ndarray:
        with open(path, "rb") as f:
            data = np.fromfile(f, dtype=np.int32, count=1)
            dim = data[0]
            f.seek(0)
            n_bytes = os.path.getsize(path)
            n_vecs = n_bytes // (4 + dim * 4)
            data = np.fromfile(f, dtype=np.int32).reshape(n_vecs, dim + 1)
            return data[:, 1:]

    vectors = read_fvecs(str(sift_dir / "sift_base.fvecs"))
    queries = read_fvecs(str(sift_dir / "sift_query.fvecs"))
    ground_truth = read_ivecs(str(sift_dir / "sift_groundtruth.ivecs"))

    if max_count and max_count < len(vectors):
        vectors = vectors[:max_count]

    texts = [f"SIFT vector {i}" for i in range(len(vectors))]
    metadata = [{"id": i} for i in range(len(vectors))]

    return Dataset(
        name=f"sift_{len(vectors)}",
        vectors=vectors,
        queries=queries,
        ground_truth=ground_truth,
        texts=texts,
        metadata=metadata,
    )
