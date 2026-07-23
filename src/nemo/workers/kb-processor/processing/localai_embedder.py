"""
Embedding generation using LocalAI API for KB processor.

DEPRECATED: This module is deprecated and not currently in use.
The system uses local SentenceTransformers embeddings instead (see embedder.py).
This code is retained for potential future use when a LocalAI embedding service
is deployed. To enable, configure EMBEDDING_PROVIDER=localai in the environment.
"""

from observability_client_runtime import get_logger
import time
import warnings
from typing import List, Optional

import pyarrow as pa
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .chunker import Chunk

logger = get_logger()

# Emit deprecation warning when module is imported
warnings.warn(
    "localai_embedder module is deprecated and not currently in use. "
    "Use embedder.py with SentenceTransformers instead.",
    DeprecationWarning,
    stacklevel=2
)


class LocalAIEmbeddingGenerator:
    """
    DEPRECATED: Generates embeddings for text chunks using LocalAI's OpenAI-compatible API.

    This class is deprecated and not currently in use. The system uses local
    SentenceTransformers embeddings instead (see EmbeddingGenerator in embedder.py).
    
    This code is retained for potential future use when a LocalAI embedding service
    is deployed.

    Creates a PyArrow table with chunk data and vector embeddings.
    """

    def __init__(
        self,
        localai_url: str = 'http://localai:8080',
        model_name: str = 'text-embedding-ada-002',
        batch_size: int = 32,
        vector_size: int = 384,
        timeout: int = 60,
        max_retries: int = 3
    ):
        """
        Initialize LocalAI embedding generator.

        DEPRECATED: This class is not currently in use. Use EmbeddingGenerator instead.

        Args:
            localai_url: Base URL for LocalAI service
            model_name: Model name to use for embeddings (e.g., 'text-embedding-ada-002')
            batch_size: Batch size for encoding (LocalAI handles batching internally)
            vector_size: Expected vector dimension
            timeout: Request timeout in seconds
            max_retries: Maximum number of retries for failed requests
        """
        warnings.warn(
            "LocalAIEmbeddingGenerator is deprecated. Use EmbeddingGenerator instead.",
            DeprecationWarning,
            stacklevel=2
        )
        self.localai_url = localai_url.rstrip('/')
        self.model_name = model_name
        self.batch_size = batch_size
        self.vector_size = vector_size
        self.timeout = timeout
        self.max_retries = max_retries
        self._session: Optional[requests.Session] = None
        self._verified = False

    def _get_session(self) -> requests.Session:
        """Get or create HTTP session with retry logic."""
        if self._session is None:
            self._session = requests.Session()
            retry_strategy = Retry(
                total=self.max_retries,
                backoff_factor=1,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=["POST", "GET"]
            )
            adapter = HTTPAdapter(max_retries=retry_strategy)
            self._session.mount("http://", adapter)
            self._session.mount("https://", adapter)
        return self._session

    def _verify_connection(self) -> None:
        """Verify LocalAI is accessible and ready."""
        if self._verified:
            return

        session = self._get_session()
        health_url = f"{self.localai_url}/readyz"
        
        logger.info(f"Verifying LocalAI connection at {self.localai_url}...")
        
        for attempt in range(self.max_retries):
            try:
                response = session.get(health_url, timeout=10)
                if response.status_code == 200:
                    self._verified = True
                    logger.info(f"LocalAI is ready at {self.localai_url}")
                    return
                else:
                    logger.warning(f"LocalAI health check returned {response.status_code}")
            except requests.exceptions.RequestException as e:
                logger.warning(f"LocalAI connection attempt {attempt + 1} failed: {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(2 ** attempt)  # Exponential backoff

        raise ConnectionError(f"Failed to connect to LocalAI at {self.localai_url}")

    def _encode_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Encode a batch of texts using LocalAI's embedding API.

        Args:
            texts: List of text strings to encode

        Returns:
            List of embedding vectors
        """
        self._verify_connection()
        session = self._get_session()
        
        url = f"{self.localai_url}/v1/embeddings"
        payload = {
            "input": texts,
            "model": self.model_name
        }

        try:
            response = session.post(url, json=payload, timeout=self.timeout)
            response.raise_for_status()
            
            result = response.json()
            
            # Extract embeddings from OpenAI-compatible response
            # Response format: {"data": [{"embedding": [...], "index": 0}, ...]}
            embeddings = []
            for item in sorted(result.get('data', []), key=lambda x: x.get('index', 0)):
                embedding = item.get('embedding', [])
                if len(embedding) != self.vector_size:
                    logger.warning(
                        f"Embedding dimension mismatch: expected {self.vector_size}, "
                        f"got {len(embedding)}. Using received dimension."
                    )
                embeddings.append(embedding)
            
            return embeddings
            
        except requests.exceptions.RequestException as e:
            logger.error(f"LocalAI embedding request failed: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.error(f"Response: {e.response.text}")
            raise

    def generate_embeddings(self, chunks: List[Chunk]) -> pa.Table:
        """
        Generate embeddings for chunks and create PyArrow table.

        Args:
            chunks: List of Chunk objects

        Returns:
            PyArrow table with columns: id, document_id, source, text, chunk_index, vector, metadata
        """
        if not chunks:
            raise ValueError("No chunks provided for embedding generation")

        # Extract texts for batch encoding
        texts = [chunk.text for chunk in chunks]
        total_chunks = len(texts)
        
        logger.info(f"Generating embeddings for {total_chunks} chunks using LocalAI...")
        logger.info(f"Model: {self.model_name}, LocalAI URL: {self.localai_url}")

        # Process in batches
        all_embeddings = []
        for i in range(0, total_chunks, self.batch_size):
            batch_texts = texts[i:i + self.batch_size]
            batch_num = i // self.batch_size + 1
            total_batches = (total_chunks + self.batch_size - 1) // self.batch_size
            
            logger.info(f"Processing batch {batch_num}/{total_batches} ({len(batch_texts)} chunks)...")
            
            batch_embeddings = self._encode_batch(batch_texts)
            all_embeddings.extend(batch_embeddings)

        # Update vector_size if we got different dimensions
        if all_embeddings and len(all_embeddings[0]) != self.vector_size:
            actual_dim = len(all_embeddings[0])
            logger.info(f"Updating vector_size from {self.vector_size} to {actual_dim}")
            self.vector_size = actual_dim

        # Build table columns
        ids = [chunk.chunk_id for chunk in chunks]
        document_ids = [chunk.document_id for chunk in chunks]
        sources = [chunk.source for chunk in chunks]
        chunk_indices = [chunk.chunk_index for chunk in chunks]
        metadatas = [chunk.metadata_json for chunk in chunks]

        # Create PyArrow table
        table = pa.table({
            'id': ids,
            'document_id': document_ids,
            'source': sources,
            'text': texts,
            'chunk_index': chunk_indices,
            'vector': all_embeddings,
            'metadata': metadatas
        })

        logger.info(f"Created PyArrow table with {len(table)} rows, {self.vector_size}-dim vectors")
        return table

    @property
    def embedding_dimension(self) -> int:
        """Get the embedding dimension."""
        return self.vector_size

    def get_model_info(self) -> dict:
        """
        Get embedding model information for metadata storage.

        Returns:
            Dictionary with model information
        """
        return {
            'model_name': self.model_name,
            'localai_url': self.localai_url,
            'vector_size': self.vector_size,
            'provider': 'localai'
        }
