"""Text chunking utilities for KB processor.

Supports multiple chunking strategies:
- fixed: Fixed-size character chunks with overlap
- sentence: Sentence-based chunking
- recursive: Recursive splitting with fallback separators
- token: Token-based chunking (LLM-aligned)
- markdown: Markdown-aware chunking by headers
"""

import json
import re
from observability_client_runtime import get_logger
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Dict, Any, Iterator, Optional

from data_sources.base import Document

logger = get_logger()


@dataclass
class Chunk:
    """Represents a text chunk with metadata."""

    chunk_id: str
    document_id: str
    chunk_index: int
    text: str
    source: str = ""  # Source identifier (file name for unstructured, table ref for structured)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def metadata_json(self) -> str:
        """Get metadata as JSON string."""
        return json.dumps(self.metadata)


class BaseChunker(ABC):
    """Abstract base class for text chunkers."""

    @abstractmethod
    def chunk_document(self, document: Document) -> List[Chunk]:
        """
        Split a document into chunks.

        Args:
            document: Document to chunk

        Returns:
            List of Chunk objects
        """
        pass

    def chunk_documents(self, documents: Iterator[Document]) -> Iterator[Chunk]:
        """
        Chunk multiple documents.

        Args:
            documents: Iterator of documents

        Yields:
            Chunk objects
        """
        doc_count = 0
        chunk_count = 0

        for doc in documents:
            chunks = self.chunk_document(doc)
            for chunk in chunks:
                yield chunk
                chunk_count += 1
            doc_count += 1

        logger.info(f"Chunked {doc_count} documents into {chunk_count} chunks")

    def _get_source(self, document: Document) -> str:
        """Get source identifier from document metadata."""
        return (
            document.metadata.get('file_name') or
            document.metadata.get('table_ref') or
            document.metadata.get('file_path', '').split('/')[-1] or
            document.doc_id
        )

    def _create_chunks(self, document: Document, text_chunks: List[str]) -> List[Chunk]:
        """Create Chunk objects from text chunks."""
        if not text_chunks:
            logger.warning(f"No chunks created for document {document.doc_id}")
            return []

        chunks = []
        total_chunks = len(text_chunks)
        source = self._get_source(document)

        for i, chunk_text in enumerate(text_chunks):
            chunk_id = f"{document.doc_id}_{i}"

            metadata = {
                **document.metadata,
                'document_id': document.doc_id,
                'chunk_index': i,
                'total_chunks': total_chunks,
            }

            chunk = Chunk(
                chunk_id=chunk_id,
                document_id=document.doc_id,
                chunk_index=i,
                text=chunk_text,
                source=source,
                metadata=metadata
            )
            chunks.append(chunk)

        logger.debug(f"Document {document.doc_id}: created {len(chunks)} chunks")
        return chunks


class FixedChunker(BaseChunker):
    """
    Splits documents into fixed-size overlapping text chunks.

    Uses character-based chunking with configurable size and overlap.
    """

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50):
        """
        Initialize fixed chunker.

        Args:
            chunk_size: Maximum characters per chunk
            chunk_overlap: Overlap characters between chunks
        """
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be less than chunk_size")

        logger.info(f"FixedChunker initialized: size={chunk_size}, overlap={chunk_overlap}")

    def chunk_document(self, document: Document) -> List[Chunk]:
        """Split a document into fixed-size chunks."""
        text = document.content
        text_chunks = self._split_text(text)
        return self._create_chunks(document, text_chunks)

    def _split_text(self, text: str) -> List[str]:
        """Split text into overlapping fixed-size chunks."""
        if not text:
            return []

        chunks = []
        start = 0

        while start < len(text):
            end = start + self.chunk_size
            chunk = text[start:end]

            if chunk.strip():
                chunks.append(chunk)

            start = end - self.chunk_overlap

            if start >= len(text):
                break

        return chunks


# Alias for backward compatibility
TextChunker = FixedChunker


class SentenceChunker(BaseChunker):
    """
    Splits documents by sentence boundaries.

    Groups sentences into chunks to preserve semantic meaning.
    """

    def __init__(
        self,
        max_sentences: int = 5,
        overlap_sentences: int = 1,
        max_sentence_chars: int = 600,
    ):
        """
        Initialize sentence chunker.

        Args:
            max_sentences: Maximum sentences per chunk
            overlap_sentences: Overlap sentences between chunks
            max_sentence_chars: Hard limit for a single sentence-like unit.
                Oversized units are further split to prevent giant chunks from
                malformed OCR/PDF text without punctuation.
        """
        self.max_sentences = max_sentences
        self.overlap_sentences = overlap_sentences
        self.max_sentence_chars = max_sentence_chars

        if overlap_sentences >= max_sentences:
            raise ValueError("overlap_sentences must be less than max_sentences")
        if max_sentence_chars <= 0:
            raise ValueError("max_sentence_chars must be positive")

        logger.info(
            "SentenceChunker initialized: max_sentences=%s, overlap=%s, max_sentence_chars=%s",
            max_sentences,
            overlap_sentences,
            max_sentence_chars,
        )

        # Try to import nltk for sentence tokenization
        try:
            import nltk
            try:
                nltk.data.find('tokenizers/punkt')
            except LookupError:
                logger.info("Downloading NLTK punkt tokenizer...")
                nltk.download('punkt', quiet=True)
                nltk.download('punkt_tab', quiet=True)
            self._nltk_available = True
        except ImportError:
            logger.warning("NLTK not available, falling back to regex sentence splitting")
            self._nltk_available = False

    def chunk_document(self, document: Document) -> List[Chunk]:
        """Split a document into sentence-based chunks."""
        text = document.content
        text_chunks = self._split_text(text)
        return self._create_chunks(document, text_chunks)

    def _split_text(self, text: str) -> List[str]:
        """Split text into chunks of sentences."""
        if not text:
            return []

        sentences = self._split_into_sentences(text)
        if not sentences:
            return []

        chunks = []
        step = self.max_sentences - self.overlap_sentences

        for i in range(0, len(sentences), step):
            chunk_sentences = sentences[i:i + self.max_sentences]
            chunk = ' '.join(chunk_sentences)
            if chunk.strip():
                chunks.append(chunk)

        return chunks

    def _split_into_sentences(self, text: str) -> List[str]:
        """Split text into sentences."""
        if self._nltk_available:
            import nltk
            raw_sentences = nltk.sent_tokenize(text)
        else:
            # Fallback regex-based sentence splitting
            sentence_endings = re.compile(r'(?<=[.!?])\s+')
            raw_sentences = sentence_endings.split(text)

        sentences: List[str] = []
        for raw in raw_sentences:
            normalized = raw.strip()
            if not normalized:
                continue
            sentences.extend(self._split_oversized_sentence(normalized))
        return sentences

    def _split_oversized_sentence(self, sentence: str) -> List[str]:
        """
        Split oversized sentence-like blocks into smaller units.

        PDF extraction and OCR can produce very long text runs with little/no
        punctuation, which would otherwise bypass sentence-count chunking.
        """
        if len(sentence) <= self.max_sentence_chars:
            return [sentence]

        # Prefer semantic-ish boundaries first, then hard-wrap on spaces.
        separators = ['\n\n', '\n', '; ', ': ', ', ', ' ']
        parts = [sentence]
        for sep in separators:
            next_parts: List[str] = []
            changed = False
            for part in parts:
                if len(part) <= self.max_sentence_chars:
                    next_parts.append(part)
                    continue
                if sep not in part:
                    next_parts.append(part)
                    continue
                changed = True
                current = ""
                for piece in part.split(sep):
                    candidate = f"{current}{sep}{piece}" if current else piece
                    if len(candidate) <= self.max_sentence_chars:
                        current = candidate
                    else:
                        if current.strip():
                            next_parts.append(current.strip())
                        current = piece
                if current.strip():
                    next_parts.append(current.strip())
            parts = next_parts
            if not changed:
                continue
            if all(len(p) <= self.max_sentence_chars for p in parts):
                break

        # Last-resort hard split for any residual giant fragments.
        final_parts: List[str] = []
        for part in parts:
            if len(part) <= self.max_sentence_chars:
                if part.strip():
                    final_parts.append(part.strip())
                continue
            start = 0
            while start < len(part):
                end = min(start + self.max_sentence_chars, len(part))
                window = part[start:end]
                if end < len(part):
                    split_at = window.rfind(' ')
                    if split_at > int(self.max_sentence_chars * 0.6):
                        end = start + split_at
                        window = part[start:end]
                if window.strip():
                    final_parts.append(window.strip())
                start = max(end, start + 1)

        return final_parts


class RecursiveChunker(BaseChunker):
    """
    Recursively splits documents using a hierarchy of separators.

    Tries larger delimiters first (paragraphs), then falls back to smaller ones.
    """

    SEPARATORS = ['\n\n\n', '\n\n', '\n', '. ', ' ']

    def __init__(self, max_chunk_size: int = 1000, chunk_overlap: int = 50):
        """
        Initialize recursive chunker.

        Args:
            max_chunk_size: Maximum characters per chunk
            chunk_overlap: Overlap characters between chunks
        """
        self.max_chunk_size = max_chunk_size
        self.chunk_overlap = chunk_overlap

        logger.info(f"RecursiveChunker initialized: max_size={max_chunk_size}, overlap={chunk_overlap}")

    def chunk_document(self, document: Document) -> List[Chunk]:
        """Split a document using recursive chunking."""
        text = document.content
        text_chunks = self._split_text(text, self.SEPARATORS)
        return self._create_chunks(document, text_chunks)

    def _split_text(self, text: str, separators: List[str]) -> List[str]:
        """Recursively split text using separators."""
        if not text:
            return []

        # If text is small enough, return it
        if len(text) <= self.max_chunk_size:
            return [text] if text.strip() else []

        # Try each separator
        for separator in separators:
            if separator in text:
                parts = text.split(separator)
                chunks = []
                current_chunk = ""

                for part in parts:
                    # If adding this part exceeds max size, save current and start new
                    if current_chunk and len(current_chunk) + len(separator) + len(part) > self.max_chunk_size:
                        if current_chunk.strip():
                            chunks.append(current_chunk.strip())
                        # Start new chunk with overlap from previous
                        if self.chunk_overlap > 0 and current_chunk:
                            overlap_text = current_chunk[-self.chunk_overlap:]
                            current_chunk = overlap_text + part
                        else:
                            current_chunk = part
                    else:
                        if current_chunk:
                            current_chunk += separator + part
                        else:
                            current_chunk = part

                # Add remaining chunk
                if current_chunk.strip():
                    chunks.append(current_chunk.strip())

                # Recursively split chunks that are still too large
                result = []
                remaining_separators = separators[separators.index(separator) + 1:]
                for chunk in chunks:
                    if len(chunk) > self.max_chunk_size and remaining_separators:
                        result.extend(self._split_text(chunk, remaining_separators))
                    else:
                        result.append(chunk)

                return result

        # No separator found, fall back to character-based splitting
        return self._character_split(text)

    def _character_split(self, text: str) -> List[str]:
        """Fall back to character-based splitting."""
        chunks = []
        start = 0

        while start < len(text):
            end = start + self.max_chunk_size
            chunk = text[start:end]

            if chunk.strip():
                chunks.append(chunk)

            start = end - self.chunk_overlap
            if start >= len(text):
                break

        return chunks


class TokenChunker(BaseChunker):
    """
    Splits documents by token count.

    Aligned with LLM context windows for optimal retrieval.
    """

    def __init__(self, max_tokens: int = 256, token_overlap: int = 20, model: str = "gpt-3.5-turbo"):
        """
        Initialize token chunker.

        Args:
            max_tokens: Maximum tokens per chunk
            token_overlap: Overlap tokens between chunks
            model: Model name for tokenizer selection
        """
        self.max_tokens = max_tokens
        self.token_overlap = token_overlap
        self.model = model

        if token_overlap >= max_tokens:
            raise ValueError("token_overlap must be less than max_tokens")

        logger.info(f"TokenChunker initialized: max_tokens={max_tokens}, overlap={token_overlap}, model={model}")

        # Try to import tiktoken
        try:
            import tiktoken
            try:
                self.encoding = tiktoken.encoding_for_model(model)
            except KeyError:
                # Fallback to cl100k_base for unknown models
                self.encoding = tiktoken.get_encoding("cl100k_base")
            self._tiktoken_available = True
        except ImportError:
            logger.warning("tiktoken not available, falling back to approximate token counting")
            self._tiktoken_available = False
            self.encoding = None

    def chunk_document(self, document: Document) -> List[Chunk]:
        """Split a document into token-based chunks."""
        text = document.content
        text_chunks = self._split_text(text)
        return self._create_chunks(document, text_chunks)

    def _split_text(self, text: str) -> List[str]:
        """Split text into chunks by token count."""
        if not text:
            return []

        if self._tiktoken_available:
            return self._split_by_tokens(text)
        else:
            return self._split_by_words(text)

    def _split_by_tokens(self, text: str) -> List[str]:
        """Split text using tiktoken."""
        tokens = self.encoding.encode(text)
        chunks = []
        step = self.max_tokens - self.token_overlap

        for i in range(0, len(tokens), step):
            chunk_tokens = tokens[i:i + self.max_tokens]
            chunk = self.encoding.decode(chunk_tokens)
            if chunk.strip():
                chunks.append(chunk)

        return chunks

    def _split_by_words(self, text: str) -> List[str]:
        """Approximate token splitting using words (fallback)."""
        # Approximate: 1 token ≈ 0.75 words (or 4 characters)
        words = text.split()
        words_per_chunk = int(self.max_tokens * 0.75)
        overlap_words = int(self.token_overlap * 0.75)
        step = words_per_chunk - overlap_words

        chunks = []
        for i in range(0, len(words), step):
            chunk_words = words[i:i + words_per_chunk]
            chunk = ' '.join(chunk_words)
            if chunk.strip():
                chunks.append(chunk)

        return chunks


class MarkdownChunker(BaseChunker):
    """
    Splits markdown documents by headers.

    Preserves document structure by splitting on markdown headers.
    """

    def __init__(self, max_chunk_size: int = 1000, split_on_headers: bool = True, chunk_overlap: int = 50):
        """
        Initialize markdown chunker.

        Args:
            max_chunk_size: Maximum characters per chunk
            split_on_headers: Whether to split on markdown headers
            chunk_overlap: Overlap characters for large sections
        """
        self.max_chunk_size = max_chunk_size
        self.split_on_headers = split_on_headers
        self.chunk_overlap = chunk_overlap

        logger.info(f"MarkdownChunker initialized: max_size={max_chunk_size}, split_on_headers={split_on_headers}")

    def chunk_document(self, document: Document) -> List[Chunk]:
        """Split a markdown document by headers."""
        text = document.content
        text_chunks = self._split_text(text)
        return self._create_chunks(document, text_chunks)

    def _split_text(self, text: str) -> List[str]:
        """Split text by markdown headers."""
        if not text:
            return []

        if not self.split_on_headers:
            # Fall back to fixed-size chunking
            return self._fixed_split(text)

        # Split on headers (##, ###, ####)
        header_pattern = re.compile(r'^(#{1,4})\s+(.+)$', re.MULTILINE)
        sections = []
        last_end = 0

        for match in header_pattern.finditer(text):
            # Add text before this header
            if match.start() > last_end:
                pre_text = text[last_end:match.start()].strip()
                if pre_text:
                    sections.append(pre_text)

            last_end = match.start()

        # Add remaining text
        if last_end < len(text):
            remaining = text[last_end:].strip()
            if remaining:
                sections.append(remaining)

        # If no headers found, treat as single section
        if not sections:
            sections = [text]

        # Split large sections further
        chunks = []
        for section in sections:
            if len(section) > self.max_chunk_size:
                chunks.extend(self._split_large_section(section))
            elif section.strip():
                chunks.append(section)

        return chunks

    def _split_large_section(self, text: str) -> List[str]:
        """Split a large section into smaller chunks."""
        # Try splitting on paragraphs first
        paragraphs = text.split('\n\n')
        chunks = []
        current_chunk = ""

        for para in paragraphs:
            if len(current_chunk) + len(para) + 2 > self.max_chunk_size:
                if current_chunk.strip():
                    chunks.append(current_chunk.strip())
                current_chunk = para
            else:
                if current_chunk:
                    current_chunk += '\n\n' + para
                else:
                    current_chunk = para

        if current_chunk.strip():
            chunks.append(current_chunk.strip())

        # If still too large, use fixed splitting
        result = []
        for chunk in chunks:
            if len(chunk) > self.max_chunk_size:
                result.extend(self._fixed_split(chunk))
            else:
                result.append(chunk)

        return result

    def _fixed_split(self, text: str) -> List[str]:
        """Fall back to fixed-size splitting."""
        chunks = []
        start = 0

        while start < len(text):
            end = start + self.max_chunk_size
            chunk = text[start:end]

            if chunk.strip():
                chunks.append(chunk)

            start = end - self.chunk_overlap
            if start >= len(text):
                break

        return chunks


def create_chunker(
    strategy: str,
    chunk_size: int = 512,
    chunk_overlap: int = 50,
    options: Optional[Dict[str, Any]] = None
) -> BaseChunker:
    """
    Factory function to create a chunker based on strategy.

    Args:
        strategy: Chunking strategy ('fixed', 'sentence', 'recursive', 'token', 'markdown')
        chunk_size: Default chunk size (used differently by each strategy)
        chunk_overlap: Default chunk overlap
        options: Strategy-specific options

    Returns:
        BaseChunker instance

    Raises:
        ValueError: If strategy is unknown
    """
    options = options or {}

    if strategy == 'fixed':
        return FixedChunker(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap
        )

    elif strategy == 'sentence':
        return SentenceChunker(
            max_sentences=options.get('maxSentences', 5),
            overlap_sentences=options.get('overlapSentences', 1),
            max_sentence_chars=options.get('maxSentenceChars', chunk_size)
        )

    elif strategy == 'recursive':
        return RecursiveChunker(
            max_chunk_size=chunk_size,
            chunk_overlap=chunk_overlap
        )

    elif strategy == 'token':
        return TokenChunker(
            max_tokens=options.get('maxTokens', 256),
            token_overlap=options.get('tokenOverlap', 20)
        )

    elif strategy == 'markdown':
        return MarkdownChunker(
            max_chunk_size=chunk_size,
            split_on_headers=options.get('splitOnHeaders', True),
            chunk_overlap=chunk_overlap
        )

    else:
        raise ValueError(f"Unknown chunking strategy: {strategy}. "
                        f"Valid strategies: fixed, sentence, recursive, token, markdown")
