from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "processing"))

from data_sources.base import Document
from chunker import SentenceChunker, create_chunker


def test_sentence_chunker_splits_oversized_unpunctuated_text():
    chunker = SentenceChunker(max_sentences=5, overlap_sentences=1, max_sentence_chars=120)
    long_text = ("very long extracted pdf text block " * 80).strip()
    doc = Document(doc_id="doc-1", content=long_text, metadata={"file_name": "sample.pdf"})

    chunks = chunker.chunk_document(doc)

    assert len(chunks) > 1
    assert all(len(c.text) <= 5 * 120 for c in chunks)
    assert all(c.text.strip() for c in chunks)


def test_create_chunker_sentence_uses_chunk_size_for_sentence_char_cap():
    chunker = create_chunker(
        strategy="sentence",
        chunk_size=90,
        chunk_overlap=0,
        options={"maxSentences": 2, "overlapSentences": 0},
    )
    assert isinstance(chunker, SentenceChunker)
    assert chunker.max_sentence_chars == 90
