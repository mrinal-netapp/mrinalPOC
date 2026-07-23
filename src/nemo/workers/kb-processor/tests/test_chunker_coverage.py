"""Additional unit tests for processing/chunker.py filling gaps left by
test_chunker.py / test_sentence_chunker.py: BaseChunker plumbing, error
branches, nltk/tiktoken fallback paths, and the character-split / large-
section fallbacks in each concrete chunker.
"""

from pathlib import Path
import sys
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "processing"))

from data_sources.base import Document
from chunker import (
    BaseChunker,
    Chunk,
    FixedChunker,
    MarkdownChunker,
    RecursiveChunker,
    SentenceChunker,
    TokenChunker,
    create_chunker,
)


def _doc(content: str, doc_id: str = "doc-1", **metadata) -> Document:
    return Document(doc_id=doc_id, content=content, metadata={"file_name": "sample.txt", **metadata})


class TestChunkDataclass:
    def test_metadata_json_serializes_metadata(self):
        chunk = Chunk(chunk_id="c1", document_id="d1", chunk_index=0, text="hi", metadata={"a": 1})
        assert chunk.metadata_json == '{"a": 1}'

    def test_metadata_json_empty_dict(self):
        chunk = Chunk(chunk_id="c1", document_id="d1", chunk_index=0, text="hi")
        assert chunk.metadata_json == "{}"


class _StubChunker(BaseChunker):
    """Minimal concrete chunker: one chunk per document, echoing content."""

    def chunk_document(self, document: Document):
        return self._create_chunks(document, [document.content])


class TestBaseChunkerAbstractStub:
    def test_chunk_document_stub_body_returns_none(self):
        class _RawStub(BaseChunker):
            def chunk_document(self, document):
                return super().chunk_document(document)

        assert _RawStub().chunk_document(_doc("x")) is None


class TestBaseChunkerChunkDocuments:
    def test_chunk_documents_yields_across_multiple_docs(self):
        chunker = _StubChunker()
        docs = [_doc("hello", doc_id="d1"), _doc("world", doc_id="d2")]
        chunks = list(chunker.chunk_documents(iter(docs)))
        assert [c.document_id for c in chunks] == ["d1", "d2"]
        assert [c.text for c in chunks] == ["hello", "world"]

    def test_chunk_documents_empty_iterator_yields_nothing(self):
        chunker = _StubChunker()
        assert list(chunker.chunk_documents(iter([]))) == []


class TestGetSource:
    def test_prefers_file_name(self):
        chunker = _StubChunker()
        doc = Document(doc_id="d1", content="x", metadata={"file_name": "a.txt", "table_ref": "ns.tbl"})
        assert chunker._get_source(doc) == "a.txt"

    def test_falls_back_to_table_ref(self):
        chunker = _StubChunker()
        doc = Document(doc_id="d1", content="x", metadata={"table_ref": "ns.tbl"})
        assert chunker._get_source(doc) == "ns.tbl"

    def test_falls_back_to_file_path_basename(self):
        chunker = _StubChunker()
        doc = Document(doc_id="d1", content="x", metadata={"file_path": "a/b/c.txt"})
        assert chunker._get_source(doc) == "c.txt"

    def test_falls_back_to_doc_id(self):
        chunker = _StubChunker()
        doc = Document(doc_id="d1", content="x", metadata={})
        assert chunker._get_source(doc) == "d1"


class TestCreateChunksEdgeCases:
    def test_no_text_chunks_returns_empty_list_with_warning(self):
        chunker = _StubChunker()
        doc = _doc("irrelevant")
        assert chunker._create_chunks(doc, []) == []


class TestFixedChunkerSplitTextDirect:
    def test_split_text_empty_string_returns_empty_list(self):
        chunker = FixedChunker(chunk_size=10, chunk_overlap=2)
        assert chunker._split_text("") == []


class TestSentenceChunkerValidation:
    def test_overlap_ge_max_sentences_raises(self):
        with pytest.raises(ValueError, match="overlap_sentences must be less than max_sentences"):
            SentenceChunker(max_sentences=2, overlap_sentences=2)

    def test_non_positive_max_sentence_chars_raises(self):
        with pytest.raises(ValueError, match="max_sentence_chars must be positive"):
            SentenceChunker(max_sentences=3, overlap_sentences=1, max_sentence_chars=0)


class TestSentenceChunkerNltkBranches:
    def test_nltk_import_error_falls_back_to_regex(self):
        with mock.patch.dict(sys.modules, {"nltk": None}):
            chunker = SentenceChunker(max_sentences=3, overlap_sentences=1)
        assert chunker._nltk_available is False

        doc = _doc("First sentence. Second sentence. Third sentence.")
        chunks = chunker.chunk_document(doc)
        assert len(chunks) >= 1

    def test_nltk_lookup_error_triggers_download(self):
        fake_nltk = mock.MagicMock()
        fake_nltk.data.find.side_effect = LookupError("not found")
        with mock.patch.dict(sys.modules, {"nltk": fake_nltk}):
            chunker = SentenceChunker(max_sentences=3, overlap_sentences=1)
        assert chunker._nltk_available is True
        fake_nltk.download.assert_any_call("punkt", quiet=True)
        fake_nltk.download.assert_any_call("punkt_tab", quiet=True)

    def test_nltk_available_used_for_tokenization(self):
        fake_nltk = mock.MagicMock()
        fake_nltk.data.find.return_value = True
        fake_nltk.sent_tokenize.return_value = ["Sentence A.", "Sentence B."]
        with mock.patch.dict(sys.modules, {"nltk": fake_nltk}):
            chunker = SentenceChunker(max_sentences=5, overlap_sentences=1)
            sentences = chunker._split_into_sentences("Sentence A. Sentence B.")
        assert sentences == ["Sentence A.", "Sentence B."]
        fake_nltk.sent_tokenize.assert_called_once()


class TestSentenceChunkerSplitTextEdgeCases:
    def test_split_text_empty_string_returns_empty_list(self):
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1)
        assert chunker._split_text("") == []

    def test_split_text_no_sentences_after_filtering_returns_empty(self):
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1)
        with mock.patch.object(chunker, "_split_into_sentences", return_value=[]):
            assert chunker._split_text("   ") == []

    def test_split_into_sentences_skips_blank_raw_sentences(self):
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1)
        # Regex fallback splits on sentence-ending punctuation; force it by
        # disabling nltk, then feed text with extra whitespace runs that
        # produce blank entries when split.
        chunker._nltk_available = False
        sentences = chunker._split_into_sentences("First.   Second.")
        assert sentences == ["First.", "Second."]

    def test_split_into_sentences_skips_blank_entries_from_nltk(self):
        fake_nltk = mock.MagicMock()
        fake_nltk.sent_tokenize.return_value = ["", "   ", "Real sentence."]
        with mock.patch.dict(sys.modules, {"nltk": fake_nltk}):
            chunker = SentenceChunker(max_sentences=3, overlap_sentences=1)
            chunker._nltk_available = True
            sentences = chunker._split_into_sentences("irrelevant")
        assert sentences == ["Real sentence."]


class TestSentenceChunkerOversizedSplitting:
    def test_hard_wrap_last_resort_split_for_giant_unbroken_word(self):
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1, max_sentence_chars=20)
        giant = "x" * 100  # no separators at all -> hits last-resort hard split
        parts = chunker._split_oversized_sentence(giant)
        assert all(len(p) <= 20 for p in parts)
        assert "".join(parts).replace(" ", "") == giant

    def test_hard_wrap_prefers_space_boundary_when_available(self):
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1, max_sentence_chars=15)
        # Long run of short "words" with no punctuation -- exercises the
        # separator-driven split as well as the final hard-wrap fallback.
        text = " ".join(["word"] * 30)
        parts = chunker._split_oversized_sentence(text)
        assert all(len(p) <= 15 for p in parts)
        assert len(parts) > 1

    def test_short_sentence_is_returned_unsplit(self):
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1, max_sentence_chars=200)
        assert chunker._split_oversized_sentence("short") == ["short"]

    def test_intermediate_fragment_already_small_enough_is_kept_as_is(self):
        # After the first separator ('\n\n') splits the sentence, one
        # resulting fragment is already within max_sentence_chars while the
        # other still needs a second separator pass ('\n') -- this exercises
        # the "already small enough, keep as-is" branch on that later pass.
        chunker = SentenceChunker(max_sentences=3, overlap_sentences=1, max_sentence_chars=30)
        sentence = "A" * 10 + "\n\n" + "B" * 5 + "\n" + "C" * 40
        parts = chunker._split_oversized_sentence(sentence)
        assert "A" * 10 in parts
        assert "B" * 5 in parts
        assert all(len(p) <= 30 for p in parts)


class TestRecursiveChunkerSplitTextDirect:
    def test_split_text_empty_string_returns_empty_list(self):
        chunker = RecursiveChunker(max_chunk_size=50, chunk_overlap=5)
        assert chunker._split_text("", chunker.SEPARATORS) == []

    def test_split_text_short_text_returns_single_chunk(self):
        chunker = RecursiveChunker(max_chunk_size=50, chunk_overlap=5)
        assert chunker._split_text("hi", chunker.SEPARATORS) == ["hi"]

    def test_split_text_short_whitespace_only_returns_empty(self):
        chunker = RecursiveChunker(max_chunk_size=50, chunk_overlap=5)
        assert chunker._split_text("   ", chunker.SEPARATORS) == []

    def test_overlap_applied_between_split_chunks(self):
        chunker = RecursiveChunker(max_chunk_size=20, chunk_overlap=5)
        text = "A" * 15 + "\n\n" + "B" * 15 + "\n\n" + "C" * 15
        chunks = chunker._split_text(text, chunker.SEPARATORS)
        assert len(chunks) >= 2

    def test_zero_overlap_starts_new_chunk_without_carrying_text_forward(self):
        # chunk_overlap=0 takes the "else: current_chunk = part" branch
        # instead of prefixing the new chunk with trailing overlap text.
        chunker = RecursiveChunker(max_chunk_size=20, chunk_overlap=0)
        text = "A" * 15 + "\n\n" + "B" * 15 + "\n\n" + "C" * 15
        chunks = chunker._split_text(text, chunker.SEPARATORS)
        assert not any(chunk.startswith("A") and "B" in chunk for chunk in chunks)

    def test_no_separator_found_falls_back_to_character_split(self):
        chunker = RecursiveChunker(max_chunk_size=10, chunk_overlap=2)
        # No separators from SEPARATORS present at all.
        text = "x" * 35
        chunks = chunker._split_text(text, [])
        assert chunks == chunker._character_split(text)
        assert all(len(c) <= 10 for c in chunks)

    def test_character_split_direct(self):
        chunker = RecursiveChunker(max_chunk_size=10, chunk_overlap=2)
        chunks = chunker._character_split("x" * 25)
        assert all(len(c) <= 10 for c in chunks)
        assert len(chunks) >= 3


class TestTokenChunkerValidation:
    def test_overlap_ge_max_tokens_raises(self):
        with pytest.raises(ValueError, match="token_overlap must be less than max_tokens"):
            TokenChunker(max_tokens=10, token_overlap=10)


class TestTokenChunkerEncodingBranches:
    def test_unknown_model_falls_back_to_cl100k_base(self):
        pytest.importorskip("tiktoken")
        chunker = TokenChunker(max_tokens=16, token_overlap=2, model="not-a-real-model")
        assert chunker._tiktoken_available is True
        assert chunker.encoding is not None

    def test_tiktoken_import_error_falls_back_to_word_splitting(self):
        with mock.patch.dict(sys.modules, {"tiktoken": None}):
            chunker = TokenChunker(max_tokens=16, token_overlap=2)
        assert chunker._tiktoken_available is False
        assert chunker.encoding is None

        doc = _doc("word " * 50)
        chunks = chunker.chunk_document(doc)
        assert len(chunks) >= 1

    def test_split_text_empty_string_returns_empty_list(self):
        pytest.importorskip("tiktoken")
        chunker = TokenChunker(max_tokens=16, token_overlap=2)
        assert chunker._split_text("") == []

    def test_split_by_words_direct(self):
        with mock.patch.dict(sys.modules, {"tiktoken": None}):
            chunker = TokenChunker(max_tokens=8, token_overlap=2)
        text = "one two three four five six seven eight nine ten"
        chunks = chunker._split_by_words(text)
        assert len(chunks) >= 1
        assert all(chunk.strip() for chunk in chunks)


class TestMarkdownChunkerSplitTextDirect:
    def test_split_text_empty_string_returns_empty_list(self):
        chunker = MarkdownChunker(max_chunk_size=100)
        assert chunker._split_text("") == []

    def test_split_on_headers_false_uses_fixed_split(self):
        chunker = MarkdownChunker(max_chunk_size=10, chunk_overlap=2, split_on_headers=False)
        chunks = chunker._split_text("x" * 35)
        assert chunks == chunker._fixed_split("x" * 35)

    def test_no_headers_present_treated_as_single_section(self):
        chunker = MarkdownChunker(max_chunk_size=500, split_on_headers=True)
        text = "Just a plain paragraph with no markdown headers at all."
        chunks = chunker._split_text(text)
        assert chunks == [text]

    def test_whitespace_only_text_with_no_headers_yields_no_chunks(self):
        # `remaining` is stripped to empty so `sections` stays empty after the
        # header-scan loop, falling back to `sections = [text]` -- but the
        # text itself is still whitespace-only, so it's filtered out below.
        chunker = MarkdownChunker(max_chunk_size=500, split_on_headers=True)
        assert chunker._split_text("   ") == []

    def test_large_section_without_headers_is_split_further(self):
        chunker = MarkdownChunker(max_chunk_size=20, split_on_headers=True, chunk_overlap=2)
        text = "para one is here\n\npara two is also here\n\npara three wraps up"
        chunks = chunker._split_text(text)
        assert all(len(c) <= 20 or "\n\n" not in c for c in chunks)
        assert len(chunks) >= 1

    def test_split_large_section_direct(self):
        chunker = MarkdownChunker(max_chunk_size=15, chunk_overlap=2)
        text = "first paragraph\n\nsecond paragraph\n\nthird paragraph is longer than fifteen chars"
        chunks = chunker._split_large_section(text)
        assert len(chunks) >= 1
        assert all(len(c) <= 15 for c in chunks)

    def test_split_large_section_accumulates_short_paragraphs_together(self):
        # With a larger max_chunk_size, two short paragraphs should be
        # accumulated into the same chunk (current_chunk += '\n\n' + para)
        # before a third, oversized paragraph forces a break.
        chunker = MarkdownChunker(max_chunk_size=40, chunk_overlap=2)
        text = (
            "short one\n\n"
            "short two\n\n"
            "third paragraph making it long enough to need splitting further after concatenation"
        )
        chunks = chunker._split_large_section(text)
        assert any("short one" in c and "short two" in c for c in chunks)

    def test_fixed_split_direct(self):
        chunker = MarkdownChunker(max_chunk_size=10, chunk_overlap=2)
        chunks = chunker._fixed_split("y" * 25)
        assert all(len(c) <= 10 for c in chunks)
        assert len(chunks) >= 3


class TestCreateChunkerRecursiveAndSentenceOptions:
    def test_recursive_strategy(self):
        chunker = create_chunker("recursive", chunk_size=200, chunk_overlap=20)
        assert isinstance(chunker, RecursiveChunker)
        assert chunker.max_chunk_size == 200
        assert chunker.chunk_overlap == 20

    def test_sentence_strategy_default_options(self):
        chunker = create_chunker("sentence", chunk_size=300)
        assert isinstance(chunker, SentenceChunker)
        assert chunker.max_sentence_chars == 300
