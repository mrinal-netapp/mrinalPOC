"""Unit tests for analyzers.image_pii (image PII detection via OCR + Presidio)."""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import analyzers.image_pii as image_pii_module
from analyzers.image_pii import (
    ImagePiiResult,
    _extract_text_with_tesseract,
    _get_ocr_engine,
    analyze_image,
)


class TestGetOcrEngine(unittest.TestCase):
    def setUp(self):
        image_pii_module._ocr_engine = None

    def tearDown(self):
        image_pii_module._ocr_engine = None

    def test_returns_cached_engine_on_second_call(self):
        image_pii_module._ocr_engine = "already-loaded"
        self.assertEqual(_get_ocr_engine(), "already-loaded")

    def test_import_error_returns_none(self):
        # Force the ImportError branch deterministically: presidio-image-redactor
        # is a real requirements.txt dependency, so it IS installed in CI (it was
        # only absent in some local/sandbox venvs) -- relying on that absence made
        # this test environment-dependent. Setting the sys.modules entry to None
        # makes `import presidio_image_redactor` raise ImportError regardless of
        # whether the real package is installed.
        with patch.dict(sys.modules, {"presidio_image_redactor": None}):
            result = _get_ocr_engine()
        self.assertIsNone(result)

    def test_generic_init_exception_returns_none(self):
        fake_module = types.ModuleType("presidio_image_redactor")

        class ExplodingEngine:
            def __init__(self):
                raise RuntimeError("model load failed")

        fake_module.ImageAnalyzerEngine = ExplodingEngine
        with patch.dict(sys.modules, {"presidio_image_redactor": fake_module}):
            result = _get_ocr_engine()
        self.assertIsNone(result)

    def test_successful_init_returns_engine(self):
        fake_module = types.ModuleType("presidio_image_redactor")
        fake_engine_instance = MagicMock()
        fake_module.ImageAnalyzerEngine = MagicMock(return_value=fake_engine_instance)
        with patch.dict(sys.modules, {"presidio_image_redactor": fake_module}):
            result = _get_ocr_engine()
        self.assertIs(result, fake_engine_instance)


class TestExtractTextWithTesseract(unittest.TestCase):
    def test_extracts_text_successfully(self):
        fake_pytesseract = types.ModuleType("pytesseract")
        fake_pytesseract.image_to_string = MagicMock(return_value="hello world")
        fake_pil_module = types.ModuleType("PIL")
        fake_image_module = types.ModuleType("PIL.Image")
        fake_image_module.open = MagicMock(return_value=MagicMock())
        fake_pil_module.Image = fake_image_module

        with patch.dict(sys.modules, {
            "pytesseract": fake_pytesseract,
            "PIL": fake_pil_module,
            "PIL.Image": fake_image_module,
        }):
            text = _extract_text_with_tesseract("/tmp/fake.png")
        self.assertEqual(text, "hello world")

    def test_returns_empty_string_when_image_to_string_returns_none(self):
        fake_pytesseract = types.ModuleType("pytesseract")
        fake_pytesseract.image_to_string = MagicMock(return_value=None)
        fake_pil_module = types.ModuleType("PIL")
        fake_image_module = types.ModuleType("PIL.Image")
        fake_image_module.open = MagicMock(return_value=MagicMock())
        fake_pil_module.Image = fake_image_module

        with patch.dict(sys.modules, {
            "pytesseract": fake_pytesseract,
            "PIL": fake_pil_module,
            "PIL.Image": fake_image_module,
        }):
            text = _extract_text_with_tesseract("/tmp/fake.png")
        self.assertEqual(text, "")

    def test_exception_returns_empty_string(self):
        # pytesseract is not installed, so this naturally raises ImportError
        # which the function catches and returns "" for.
        text = _extract_text_with_tesseract("/tmp/nonexistent.png")
        self.assertEqual(text, "")


class TestAnalyzeImage(unittest.TestCase):
    def setUp(self):
        image_pii_module._ocr_engine = None

    def tearDown(self):
        image_pii_module._ocr_engine = None

    def test_presidio_engine_success_path(self):
        class FakeResult:
            def __init__(self, entity_type):
                self.entity_type = entity_type

        fake_engine = MagicMock()
        fake_engine.analyze = MagicMock(
            return_value=[FakeResult("US_SSN"), FakeResult("PERSON")]
        )

        fake_pil_module = types.ModuleType("PIL")
        fake_image_module = types.ModuleType("PIL.Image")
        fake_image_module.open = MagicMock(return_value=MagicMock())
        fake_pil_module.Image = fake_image_module

        with patch.object(image_pii_module, "_get_ocr_engine", return_value=fake_engine):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = analyze_image("/tmp/scan.png")

        self.assertEqual(result.count, 2)
        self.assertEqual(set(result.entities), {"US_SSN", "PERSON"})
        self.assertIsInstance(result, ImagePiiResult)

    def test_presidio_engine_failure_falls_back_to_tesseract(self):
        fake_engine = MagicMock()

        fake_pil_module = types.ModuleType("PIL")
        fake_image_module = types.ModuleType("PIL.Image")
        fake_image_module.open = MagicMock(side_effect=RuntimeError("bad image"))
        fake_pil_module.Image = fake_image_module

        with patch.object(image_pii_module, "_get_ocr_engine", return_value=fake_engine):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                with patch.object(
                    image_pii_module, "_extract_text_with_tesseract", return_value=""
                ) as mock_tesseract:
                    result = analyze_image("/tmp/scan.png")

        mock_tesseract.assert_called_once()
        self.assertEqual(result, ImagePiiResult())

    def test_no_engine_falls_back_to_tesseract_with_pii_found(self):
        from analyzers.pii import PiiResult

        with patch.object(image_pii_module, "_get_ocr_engine", return_value=None):
            with patch.object(
                image_pii_module, "_extract_text_with_tesseract",
                return_value="SSN: 123-45-6789",
            ):
                with patch.object(
                    image_pii_module, "analyze_text",
                    return_value=PiiResult(entities=["US_SSN"], count=1),
                ) as mock_analyze_text:
                    result = analyze_image("/tmp/scan.png")

        mock_analyze_text.assert_called_once()
        self.assertEqual(result.count, 1)
        self.assertEqual(result.entities, ["US_SSN"])

    def test_no_engine_and_no_extracted_text_returns_empty_result(self):
        with patch.object(image_pii_module, "_get_ocr_engine", return_value=None):
            with patch.object(
                image_pii_module, "_extract_text_with_tesseract", return_value=""
            ):
                result = analyze_image("/tmp/blank.png")

        self.assertEqual(result, ImagePiiResult())

    def test_no_engine_and_whitespace_only_text_returns_empty_result(self):
        with patch.object(image_pii_module, "_get_ocr_engine", return_value=None):
            with patch.object(
                image_pii_module, "_extract_text_with_tesseract", return_value="   \n  "
            ):
                result = analyze_image("/tmp/blank.png")

        self.assertEqual(result, ImagePiiResult())


if __name__ == "__main__":
    unittest.main()
