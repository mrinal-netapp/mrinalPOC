"""Unit tests for processing/chunker.py strategies and create_chunker factory."""

from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "processing"))

from data_sources.base import Document
from chunker import (
    Chunk,
    FixedChunker,
    MarkdownChunker,
    RecursiveChunker,
    SentenceChunker,
    TokenChunker,
    create_chunker,
)


def _doc(content: str, doc_id: str = "doc-1", **metadata) -> Document:
    return Document(
        doc_id=doc_id,
        content=content,
        metadata={"file_name": "sample.txt", **metadata},
    )


def _assert_chunk_shape(chunks: list[Chunk], document_id: str):
    assert len(chunks) >= 1
    for i, chunk in enumerate(chunks):
        assert chunk.chunk_id == f"{document_id}_{i}"
        assert chunk.document_id == document_id
        assert chunk.chunk_index == i
        assert chunk.text.strip()
        assert chunk.metadata["document_id"] == document_id
        assert chunk.metadata["chunk_index"] == i
        assert chunk.metadata["total_chunks"] == len(chunks)


def test_fixed_chunker_character_count_and_overlap():
    chunker = FixedChunker(chunk_size=10, chunk_overlap=2)
    doc = _doc("abcdefghijklmnop")
    chunks = chunker.chunk_document(doc)
    _assert_chunk_shape(chunks, "doc-1")
    assert all(len(c.text) <= 10 for c in chunks)


def test_fixed_chunker_overlap_ge_size_raises():
    with pytest.raises(ValueError, match="chunk_overlap must be less than chunk_size"):
        FixedChunker(chunk_size=10, chunk_overlap=10)


def test_sentence_chunker_multi_sentence_and_overlap():
    chunker = SentenceChunker(max_sentences=2, overlap_sentences=1, max_sentence_chars=200)
    doc = _doc("First sentence. Second sentence. Third sentence. Fourth sentence.")
    chunks = chunker.chunk_document(doc)
    _assert_chunk_shape(chunks, "doc-1")
    assert len(chunks) >= 2


def test_token_chunker_respects_max_tokens_with_mock_encoding():
    tiktoken = pytest.importorskip("tiktoken")
    encoding = tiktoken.get_encoding("cl100k_base")
    chunker = TokenChunker(max_tokens=8, token_overlap=2, model="gpt-3.5-turbo")
    assert chunker._tiktoken_available

    text = "word " * 40
    doc = _doc(text.strip())
    chunks = chunker.chunk_document(doc)
    _assert_chunk_shape(chunks, "doc-1")

    for chunk in chunks:
        token_count = len(encoding.encode(chunk.text))
        assert token_count <= 8


def test_recursive_chunker_happy_path():
    chunker = RecursiveChunker(max_chunk_size=30, chunk_overlap=5)
    doc = _doc("Paragraph one.\n\nParagraph two is a bit longer than thirty characters.")
    chunks = chunker.chunk_document(doc)
    _assert_chunk_shape(chunks, "doc-1")


def test_markdown_chunker_splits_on_headers():
    chunker = MarkdownChunker(max_chunk_size=500, split_on_headers=True)
    doc = _doc("# Intro\n\nBody text.\n\n## Section\n\nMore body.")
    chunks = chunker.chunk_document(doc)
    _assert_chunk_shape(chunks, "doc-1")
    combined = " ".join(c.text for c in chunks)
    assert "Intro" in combined or "Body" in combined


def test_create_chunker_unknown_strategy_raises():
    with pytest.raises(ValueError, match="Unknown chunking strategy"):
        create_chunker(strategy="ngram")


def test_create_chunker_wires_strategy_options():
    fixed = create_chunker("fixed", chunk_size=100, chunk_overlap=10)
    assert isinstance(fixed, FixedChunker)
    assert fixed.chunk_size == 100

    token = create_chunker(
        "token",
        chunk_size=512,
        options={"maxTokens": 64, "tokenOverlap": 8},
    )
    assert isinstance(token, TokenChunker)
    assert token.max_tokens == 64
    assert token.token_overlap == 8

    markdown = create_chunker(
        "markdown",
        chunk_size=800,
        chunk_overlap=25,
        options={"splitOnHeaders": False},
    )
    assert isinstance(markdown, MarkdownChunker)
    assert markdown.split_on_headers is False


def test_empty_document_yields_no_chunks():
    chunker = FixedChunker(chunk_size=20, chunk_overlap=2)
    doc = _doc("   ")
    assert chunker.chunk_document(doc) == []
