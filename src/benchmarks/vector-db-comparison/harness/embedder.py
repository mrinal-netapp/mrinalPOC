"""Shared embedding generator using SentenceTransformers.

Pre-computes embeddings once so both stores use identical vectors.
"""

import logging
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


class Embedder:
    """Wrapper around SentenceTransformers for generating embeddings."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2"):
        self._model_name = model_name
        self._model = None

    def _ensure_loaded(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            logger.info("Loading embedding model: %s", self._model_name)
            self._model = SentenceTransformer(self._model_name)

    @property
    def dimension(self) -> int:
        self._ensure_loaded()
        return self._model.get_sentence_embedding_dimension()

    def encode(self, texts: list[str], batch_size: int = 256, show_progress: bool = False) -> np.ndarray:
        self._ensure_loaded()
        embeddings = self._model.encode(
            texts, batch_size=batch_size, show_progress_bar=show_progress, normalize_embeddings=True
        )
        return np.array(embeddings, dtype=np.float32)

    def encode_query(self, query: str) -> np.ndarray:
        return self.encode([query])[0]
