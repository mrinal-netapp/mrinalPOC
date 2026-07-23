"""Unit tests for analyzers.pii (text PII detection via Presidio + optional GLiNER)."""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import analyzers.pii as pii_module
from analyzers.pii import (
    PiiResult,
    _get_analyzer,
    _split_text_chunks,
    analyze_text,
    get_risk_level,
    highest_risk_level,
)


class TestGetRiskLevel(unittest.TestCase):
    def test_known_entity_returns_mapped_tier(self):
        self.assertEqual(get_risk_level("US_SSN"), "high")
        self.assertEqual(get_risk_level("PERSON"), "medium")
        self.assertEqual(get_risk_level("DATE_TIME"), "low")

    def test_unknown_entity_defaults_to_medium(self):
        self.assertEqual(get_risk_level("SOME_UNKNOWN_ENTITY"), "medium")


class TestPiiResultToJson(unittest.TestCase):
    def test_to_json_serializes_sorted_unique_entities(self):
        result = PiiResult(entities=["US_SSN", "PERSON", "US_SSN"])
        self.assertEqual(result.to_json(), '["PERSON", "US_SSN"]')

    def test_to_json_empty_entities(self):
        result = PiiResult()
        self.assertEqual(result.to_json(), "[]")


class TestHighestRiskLevel(unittest.TestCase):
    def test_empty_list_returns_none(self):
        self.assertEqual(highest_risk_level([]), "none")

    def test_single_high_entity(self):
        self.assertEqual(highest_risk_level(["US_SSN"]), "high")

    def test_mixed_entities_returns_highest(self):
        self.assertEqual(highest_risk_level(["DATE_TIME", "PERSON", "US_SSN"]), "high")

    def test_only_low_entities_returns_low(self):
        self.assertEqual(highest_risk_level(["DATE_TIME", "URL"]), "low")

    def test_only_medium_entities_returns_medium(self):
        self.assertEqual(highest_risk_level(["PERSON", "EMAIL_ADDRESS"]), "medium")

    def test_stops_early_once_high_found(self):
        # Should short-circuit on first "high" without needing to scan further;
        # verify correctness of the resulting classification either way.
        self.assertEqual(
            highest_risk_level(["US_SSN", "UNKNOWN_ENTITY_TYPE"]), "high"
        )


class TestSplitTextChunks(unittest.TestCase):
    def test_short_text_single_chunk(self):
        chunks = _split_text_chunks("hello world", max_chars=100)
        self.assertEqual(chunks, ["hello world"])

    def test_splits_on_newline_boundary(self):
        text = ("a" * 10) + "\n" + ("b" * 10)
        chunks = _split_text_chunks(text, max_chars=15)
        # Should break at the newline within the window rather than mid-word.
        self.assertEqual(chunks[0], "a" * 10 + "\n")
        self.assertEqual("".join(chunks), text)

    def test_hard_splits_when_no_newline_found(self):
        text = "a" * 30
        chunks = _split_text_chunks(text, max_chars=10)
        self.assertEqual(chunks, ["a" * 10, "a" * 10, "a" * 10])

    def test_final_chunk_takes_remainder(self):
        text = "x" * 25
        chunks = _split_text_chunks(text, max_chars=10)
        self.assertEqual("".join(chunks), text)
        self.assertEqual(chunks[-1], "x" * 5)


def _install_fake_presidio_analyzer(analyze_return=None, init_side_effect=None):
    """Install a fake ``presidio_analyzer`` module into sys.modules."""
    fake_module = types.ModuleType("presidio_analyzer")

    class FakeAnalyzerEngine:
        def __init__(self):
            if init_side_effect is not None:
                raise init_side_effect
            self.registry = MagicMock()

        def analyze(self, text, language, score_threshold):
            if analyze_return is None:
                return []
            return analyze_return

    class FakeRecognizerResult:
        def __init__(self, entity_type, start, end, score, analysis_explanation=None,
                     recognition_metadata=None):
            self.entity_type = entity_type
            self.start = start
            self.end = end
            self.score = score

    fake_module.AnalyzerEngine = FakeAnalyzerEngine
    fake_module.RecognizerResult = FakeRecognizerResult
    return fake_module


class TestGetAnalyzer(unittest.TestCase):
    def setUp(self):
        # Reset module-level singleton state before each test.
        pii_module._analyzer_engine = None
        pii_module._gliner_recognizer_loaded = False

    def tearDown(self):
        pii_module._analyzer_engine = None
        pii_module._gliner_recognizer_loaded = False

    def test_returns_cached_singleton_on_second_call(self):
        fake_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            first = _get_analyzer()
            second = _get_analyzer()
        self.assertIs(first, second)

    def test_presidio_init_failure_raises(self):
        fake_module = _install_fake_presidio_analyzer(
            init_side_effect=RuntimeError("boom")
        )
        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            with self.assertRaises(RuntimeError):
                _get_analyzer()

    def test_gliner_import_error_is_non_fatal(self):
        # `gliner` package is not installed in the test environment, so
        # GlinerRecognizer() will raise ImportError internally; _get_analyzer
        # should swallow it and still return a working analyzer.
        fake_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            analyzer = _get_analyzer()
        self.assertIsNotNone(analyzer)
        self.assertFalse(pii_module._gliner_recognizer_loaded)

    def test_gliner_generic_exception_is_non_fatal(self):
        fake_module = _install_fake_presidio_analyzer()
        fake_gliner_module = types.ModuleType("analyzers._gliner_recognizer")

        class ExplodingGlinerRecognizer:
            def __init__(self):
                raise ValueError("model load failed")

        fake_gliner_module.GlinerRecognizer = ExplodingGlinerRecognizer

        with patch.dict(sys.modules, {
            "presidio_analyzer": fake_module,
            "analyzers._gliner_recognizer": fake_gliner_module,
        }):
            analyzer = _get_analyzer()
        self.assertIsNotNone(analyzer)
        self.assertFalse(pii_module._gliner_recognizer_loaded)

    def test_gliner_success_registers_recognizer(self):
        fake_module = _install_fake_presidio_analyzer()
        fake_gliner_module = types.ModuleType("analyzers._gliner_recognizer")

        class WorkingGlinerRecognizer:
            def __init__(self):
                self.id = "gliner_recognizer"

        fake_gliner_module.GlinerRecognizer = WorkingGlinerRecognizer

        with patch.dict(sys.modules, {
            "presidio_analyzer": fake_module,
            "analyzers._gliner_recognizer": fake_gliner_module,
        }):
            analyzer = _get_analyzer()
        self.assertIsNotNone(analyzer)
        self.assertTrue(pii_module._gliner_recognizer_loaded)
        analyzer.registry.add_recognizer.assert_called_once()


class TestAnalyzeText(unittest.TestCase):
    def setUp(self):
        pii_module._analyzer_engine = None
        pii_module._gliner_recognizer_loaded = False

    def tearDown(self):
        pii_module._analyzer_engine = None
        pii_module._gliner_recognizer_loaded = False

    def test_empty_text_returns_empty_result(self):
        result = analyze_text("")
        self.assertEqual(result, PiiResult())

    def test_whitespace_only_text_returns_empty_result(self):
        result = analyze_text("   \n\t  ")
        self.assertEqual(result, PiiResult())

    def test_oversized_text_is_truncated_before_analysis(self):
        fake_module = _install_fake_presidio_analyzer(analyze_return=[])
        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            with patch.object(pii_module.logger, "warning") as mock_warn:
                analyze_text("a" * 100, max_size=10)
                mock_warn.assert_called_once()

    def test_single_chunk_happy_path_computes_risk_counts(self):
        class Result:
            def __init__(self, entity_type):
                self.entity_type = entity_type

        fake_module = _install_fake_presidio_analyzer(
            analyze_return=[Result("US_SSN"), Result("PERSON"), Result("DATE_TIME")]
        )
        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            result = analyze_text("John's SSN is 123-45-6789, born 1990-01-01")

        self.assertEqual(result.count, 3)
        self.assertEqual(result.high_risk_count, 1)
        self.assertEqual(result.medium_risk_count, 1)
        self.assertEqual(result.low_risk_count, 1)
        self.assertEqual(result.risk_level, "high")

    def test_multi_chunk_text_is_split_and_merged(self):
        class Result:
            def __init__(self, entity_type):
                self.entity_type = entity_type

        call_count = {"n": 0}
        fake_module = types.ModuleType("presidio_analyzer")

        class FakeAnalyzerEngine:
            def __init__(self):
                self.registry = MagicMock()

            def analyze(self, text, language, score_threshold):
                call_count["n"] += 1
                return [Result("PERSON")]

        fake_module.AnalyzerEngine = FakeAnalyzerEngine

        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            with patch.object(pii_module, "CHUNK_MAX_CHARS", 10):
                text = "word " * 10  # 50 chars, > 10-char chunk limit
                result = analyze_text(text)

        self.assertGreater(call_count["n"], 1)
        self.assertEqual(result.count, call_count["n"])

    def test_per_chunk_failure_continues_with_other_chunks(self):
        class Result:
            def __init__(self, entity_type):
                self.entity_type = entity_type

        fake_module = types.ModuleType("presidio_analyzer")
        call_state = {"n": 0}

        class FakeAnalyzerEngine:
            def __init__(self):
                self.registry = MagicMock()

            def analyze(self, text, language, score_threshold):
                call_state["n"] += 1
                if call_state["n"] == 1:
                    raise RuntimeError("chunk failed")
                return [Result("EMAIL_ADDRESS")]

        fake_module.AnalyzerEngine = FakeAnalyzerEngine

        with patch.dict(sys.modules, {"presidio_analyzer": fake_module}):
            with patch.object(pii_module, "CHUNK_MAX_CHARS", 10):
                text = "word " * 10
                result = analyze_text(text)

        # First chunk raises and is skipped; remaining chunks still contribute.
        self.assertGreaterEqual(call_state["n"], 2)
        self.assertEqual(result.count, call_state["n"] - 1)
        self.assertTrue(all(e == "EMAIL_ADDRESS" for e in result.entities))

    def test_top_level_exception_returns_empty_result(self):
        with patch.object(pii_module, "_get_analyzer", side_effect=RuntimeError("boom")):
            result = analyze_text("some text with content")
        self.assertEqual(result, PiiResult())


if __name__ == "__main__":
    unittest.main()
