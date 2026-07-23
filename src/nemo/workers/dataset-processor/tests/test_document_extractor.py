"""Unit tests for analyzers.document_extractor.

Tests cover:
- Text extraction from PDF, DOCX, and PPTX files (happy path)
- Password-protected / unreadable files return None
- Files exceeding MAX_DOCUMENT_SIZE_BYTES return None
- Unsupported extensions return None
- _run_pii_analysis routes .pdf / .docx / .pptx to the document branch
"""

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import pytest

from processing.config import Config
from processing.files import _is_document_file, _run_pii_analysis
from analyzers.document_extractor import (
    MAX_DOCUMENT_SIZE_BYTES,
    _check_file_size,
    _extract_docx,
    _extract_pdf,
    _extract_pptx,
    extract_document_text,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

fitz = pytest.importorskip("fitz", reason="pymupdf not installed")
docx_mod = pytest.importorskip("docx", reason="python-docx not installed")
pptx_mod = pytest.importorskip("pptx", reason="python-pptx not installed")


def _make_pdf(path: str, text: str) -> None:
    """Create a minimal single-page PDF containing *text*."""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    doc.save(path)
    doc.close()


def _make_docx(path: str, text: str) -> None:
    """Create a minimal DOCX file with a single paragraph containing *text*."""
    from docx import Document
    doc = Document()
    doc.add_paragraph(text)
    doc.save(path)


def _make_pptx(path: str, text: str) -> None:
    """Create a minimal PPTX file with one slide containing *text*."""
    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    slide_layout = prs.slide_layouts[5]  # blank layout
    slide = prs.slides.add_slide(slide_layout)
    txBox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(2))
    txBox.text_frame.text = text
    prs.save(path)


def _minimal_config(**overrides) -> Config:
    base = {
        "dataset_id": "ds-test",
        "dataset_name": "test-ds",
        "project_id": "proj-1",
        "bucket_name": "bucket",
        "project_client_id": "cid",
        "project_client_secret": "secret",
        "aws_access_key_id": "ak",
        "aws_secret_access_key": "sk",
        "s3_endpoint": "http://s3:7070",
    }
    base.update(overrides)
    return Config.from_dict(base)


# ---------------------------------------------------------------------------
# extract_document_text — happy path
# ---------------------------------------------------------------------------

class TestExtractPdf(unittest.TestCase):
    def test_extracts_text_from_pdf(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            _make_pdf(path, "Hello from PDF")
            result = extract_document_text(path, ".pdf")
            self.assertIsNotNone(result)
            self.assertIn("Hello from PDF", result)
        finally:
            os.unlink(path)

    def test_empty_pdf_returns_empty_string(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            doc = fitz.open()
            doc.new_page()  # blank page, no text
            doc.save(path)
            doc.close()
            result = extract_document_text(path, ".pdf")
            self.assertIsNotNone(result)
            self.assertEqual(result.strip(), "")
        finally:
            os.unlink(path)


class TestExtractDocx(unittest.TestCase):
    def test_extracts_paragraph_text(self):
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = f.name
        try:
            _make_docx(path, "Sensitive DOCX content")
            result = extract_document_text(path, ".docx")
            self.assertIsNotNone(result)
            self.assertIn("Sensitive DOCX content", result)
        finally:
            os.unlink(path)

    def test_extracts_table_cell_text(self):
        from docx import Document
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = f.name
        try:
            doc = Document()
            table = doc.add_table(rows=1, cols=2)
            table.cell(0, 0).text = "Cell A"
            table.cell(0, 1).text = "Cell B"
            doc.save(path)
            result = extract_document_text(path, ".docx")
            self.assertIsNotNone(result)
            self.assertIn("Cell A", result)
            self.assertIn("Cell B", result)
        finally:
            os.unlink(path)


class TestExtractPptx(unittest.TestCase):
    def test_extracts_slide_text(self):
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
            path = f.name
        try:
            _make_pptx(path, "Slide PII content")
            result = extract_document_text(path, ".pptx")
            self.assertIsNotNone(result)
            self.assertIn("Slide PII content", result)
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# extract_document_text — unsupported extension
# ---------------------------------------------------------------------------

class TestUnsupportedExtension(unittest.TestCase):
    def test_returns_none_for_xlsx(self):
        result = extract_document_text("/fake/path/file.xlsx", ".xlsx")
        self.assertIsNone(result)

    def test_returns_none_for_unknown_extension(self):
        result = extract_document_text("/fake/path/file.bin", ".bin")
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# extract_document_text — size limit
# ---------------------------------------------------------------------------

class TestSizeLimit(unittest.TestCase):
    def test_oversized_file_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            # Mock os.path.getsize to report a size over the limit
            oversized = MAX_DOCUMENT_SIZE_BYTES + 1
            with mock.patch("analyzers.document_extractor.os.path.getsize", return_value=oversized):
                result = extract_document_text(path, ".pdf")
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_file_at_exact_limit_is_allowed(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            _make_pdf(path, "boundary test")
            with mock.patch(
                "analyzers.document_extractor.os.path.getsize",
                return_value=MAX_DOCUMENT_SIZE_BYTES,
            ):
                result = extract_document_text(path, ".pdf")
            # Should attempt extraction (not None due to size); result depends on content
            self.assertIsNotNone(result)
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# extract_document_text — password protection
# ---------------------------------------------------------------------------

class TestPasswordProtection(unittest.TestCase):
    def test_password_protected_pdf_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            _make_pdf(path, "secret")
            # Simulate a password-protected PDF by patching needs_pass on the doc
            mock_doc = mock.MagicMock()
            mock_doc.needs_pass = True
            with mock.patch("fitz.open", return_value=mock_doc):
                result = extract_document_text(path, ".pdf")
            self.assertIsNone(result)
            mock_doc.close.assert_called_once()
        finally:
            os.unlink(path)

    def test_encrypted_docx_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = f.name
        try:
            # Simulate an encrypted DOCX (python-docx raises on open)
            with mock.patch(
                "docx.Document",
                side_effect=Exception("File is encrypted"),
            ):
                result = extract_document_text(path, ".docx")
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_encrypted_pptx_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
            path = f.name
        try:
            with mock.patch(
                "pptx.Presentation",
                side_effect=Exception("password protected"),
            ):
                result = extract_document_text(path, ".pptx")
            self.assertIsNone(result)
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# _check_file_size
# ---------------------------------------------------------------------------

class TestCheckFileSize(unittest.TestCase):
    def test_oserror_getting_size_returns_false(self):
        with mock.patch(
            "analyzers.document_extractor.os.path.getsize",
            side_effect=OSError("no such file"),
        ):
            self.assertFalse(_check_file_size("/no/such/file.pdf"))


# ---------------------------------------------------------------------------
# Per-format extractor edge cases (ImportError / open failures / per-item
# extraction failures) — exercised directly against the private extractors.
# ---------------------------------------------------------------------------

class TestExtractPdfEdgeCases(unittest.TestCase):
    def test_import_error_returns_none(self):
        with mock.patch.dict(sys.modules, {"fitz": None}):
            self.assertIsNone(_extract_pdf("/fake/path.pdf"))

    def test_empty_file_error_returns_empty_string(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            with mock.patch("fitz.open", side_effect=fitz.EmptyFileError("empty")):
                result = _extract_pdf(path)
            self.assertEqual(result, "")
        finally:
            os.unlink(path)

    def test_generic_open_failure_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            with mock.patch("fitz.open", side_effect=RuntimeError("corrupt file")):
                result = _extract_pdf(path)
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_per_page_extraction_failure_continues(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            _make_pdf(path, "page one text")
            real_doc = fitz.open(path)
            # Force get_text() to raise on the (only) page to exercise the
            # per-page exception-continue branch, while still exercising the
            # real doc.close()/needs_pass flow.
            with mock.patch.object(type(real_doc[0]), "get_text", side_effect=RuntimeError("bad page")):
                with mock.patch("fitz.open", return_value=real_doc):
                    result = _extract_pdf(path)
            self.assertEqual(result, "")
        finally:
            os.unlink(path)


class TestExtractDocxEdgeCases(unittest.TestCase):
    def test_import_error_returns_none(self):
        with mock.patch.dict(sys.modules, {"docx": None}):
            self.assertIsNone(_extract_docx("/fake/path.docx"))

    def test_generic_open_failure_without_encryption_keyword_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = f.name
        try:
            with mock.patch("docx.Document", side_effect=RuntimeError("corrupt zip")):
                result = _extract_docx(path)
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_package_not_found_error_returns_none(self):
        from docx.opc.exceptions import PackageNotFoundError

        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = f.name
        try:
            with mock.patch("docx.Document", side_effect=PackageNotFoundError("not a docx")):
                result = _extract_docx(path)
            self.assertIsNone(result)
        finally:
            os.unlink(path)


class TestExtractPptxEdgeCases(unittest.TestCase):
    def test_import_error_returns_none(self):
        with mock.patch.dict(sys.modules, {"pptx": None}):
            self.assertIsNone(_extract_pptx("/fake/path.pptx"))

    def test_generic_open_failure_without_encryption_keyword_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
            path = f.name
        try:
            with mock.patch("pptx.Presentation", side_effect=RuntimeError("corrupt zip")):
                result = _extract_pptx(path)
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_package_not_found_error_returns_none(self):
        from pptx.exc import PackageNotFoundError

        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
            path = f.name
        try:
            with mock.patch("pptx.Presentation", side_effect=PackageNotFoundError("not a pptx")):
                result = _extract_pptx(path)
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_shapes_without_text_frame_are_skipped(self):
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
            path = f.name
        try:
            from pptx import Presentation
            from pptx.util import Inches

            prs = Presentation()
            slide_layout = prs.slide_layouts[5]
            slide = prs.slides.add_slide(slide_layout)
            # Picture-less shape without a text frame: add a simple line/connector
            # via shapes.add_connector, which has no text_frame.
            from pptx.enum.shapes import MSO_CONNECTOR
            slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(0), Inches(0), Inches(1), Inches(1))
            prs.save(path)

            result = _extract_pptx(path)
            self.assertEqual(result, "")
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# extract_document_text — dispatcher exception wrapping
# ---------------------------------------------------------------------------

class TestExtractDocumentTextDispatcherErrors(unittest.TestCase):
    """`_EXTRACTORS` binds each extractor function by reference at import
    time, so these patch the dict entry directly rather than the module-level
    `_extract_pdf` name (patching the latter would not affect dispatch)."""

    def test_unexpected_extractor_exception_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            fake_extractor = mock.Mock(side_effect=RuntimeError("totally unexpected"))
            with mock.patch.dict(
                "analyzers.document_extractor._EXTRACTORS", {".pdf": fake_extractor}
            ):
                result = extract_document_text(path, ".pdf")
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_none_result_logs_info_branch(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            fake_extractor = mock.Mock(return_value=None)
            with mock.patch.dict(
                "analyzers.document_extractor._EXTRACTORS", {".pdf": fake_extractor}
            ):
                result = extract_document_text(path, ".pdf")
            self.assertIsNone(result)
        finally:
            os.unlink(path)

    def test_empty_result_logs_info_branch(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = f.name
        try:
            fake_extractor = mock.Mock(return_value="   ")
            with mock.patch.dict(
                "analyzers.document_extractor._EXTRACTORS", {".pdf": fake_extractor}
            ):
                result = extract_document_text(path, ".pdf")
            self.assertEqual(result, "   ")
        finally:
            os.unlink(path)


# ---------------------------------------------------------------------------
# Config — document extension / MIME classification
# ---------------------------------------------------------------------------

class TestIsDocumentFile(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    def test_pdf_extension(self):
        self.assertTrue(_is_document_file(self.config, "application/octet-stream", ".pdf"))

    def test_docx_extension(self):
        self.assertTrue(_is_document_file(self.config, "application/octet-stream", ".docx"))

    def test_pptx_extension(self):
        self.assertTrue(_is_document_file(self.config, "application/octet-stream", ".pptx"))

    def test_pdf_by_mime(self):
        self.assertTrue(_is_document_file(self.config, "application/pdf", ""))

    def test_docx_by_mime(self):
        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        self.assertTrue(_is_document_file(self.config, mime, ""))

    def test_pptx_by_mime(self):
        mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        self.assertTrue(_is_document_file(self.config, mime, ""))

    def test_txt_is_not_document(self):
        self.assertFalse(_is_document_file(self.config, "text/plain", ".txt"))

    def test_png_is_not_document(self):
        self.assertFalse(_is_document_file(self.config, "image/png", ".png"))


# ---------------------------------------------------------------------------
# _run_pii_analysis — document routing
# ---------------------------------------------------------------------------

class TestRunPiiAnalysisDocumentRouting(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config(enable_pii_analysis=True)

    def _fake_pii_hit(self):
        """Mock a PiiResult-shaped object for `analyze_text`.

        The real Presidio+spaCy pipeline is not installed in the unit-test
        environment; these tests exercise the document-routing logic in
        `_run_pii_analysis` (extraction -> analyze_text -> result shaping),
        not Presidio's actual entity detection accuracy (covered separately
        in `test_analyzers_pii.py` with a mocked AnalyzerEngine).
        """
        from analyzers.pii import PiiResult
        return PiiResult(
            entities=["US_SSN", "EMAIL_ADDRESS"],
            count=2,
            risk_level="high",
            high_risk_count=1,
            medium_risk_count=1,
            low_risk_count=0,
        )

    def test_pdf_with_pii_detected(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = Path(f.name)
        try:
            _make_pdf(str(path), "SSN: 123-45-6789 and email test@example.com")
            with mock.patch("analyzers.pii.analyze_text", return_value=self._fake_pii_hit()):
                result = _run_pii_analysis(self.config, path, "application/pdf", ".pdf")
            self.assertTrue(result["has_pii"])
            self.assertGreater(result["pii_count"], 0)
            self.assertNotIn(result["pii_risk_level"], ("", "none"))
        finally:
            path.unlink(missing_ok=True)

    def test_docx_with_pii_detected(self):
        with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
            path = Path(f.name)
        try:
            _make_docx(str(path), "Contact: john.doe@company.com, phone 555-867-5309")
            with mock.patch("analyzers.pii.analyze_text", return_value=self._fake_pii_hit()):
                result = _run_pii_analysis(self.config, path, "application/octet-stream", ".docx")
            self.assertTrue(result["has_pii"])
            self.assertGreater(result["pii_count"], 0)
        finally:
            path.unlink(missing_ok=True)

    def test_pptx_with_pii_detected(self):
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
            path = Path(f.name)
        try:
            _make_pptx(str(path), "SSN: 123-45-6789 and email test@example.com")
            with mock.patch("analyzers.pii.analyze_text", return_value=self._fake_pii_hit()):
                result = _run_pii_analysis(self.config, path, "application/octet-stream", ".pptx")
            self.assertTrue(result["has_pii"])
            self.assertGreater(result["pii_count"], 0)
        finally:
            path.unlink(missing_ok=True)

    def test_password_protected_pdf_returns_null_pii_fields(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = Path(f.name)
        try:
            _make_pdf(str(path), "secret content")
            mock_doc = mock.MagicMock()
            mock_doc.needs_pass = True
            with mock.patch("fitz.open", return_value=mock_doc):
                result = _run_pii_analysis(self.config, path, "application/pdf", ".pdf")
            self.assertIsNone(result["has_pii"])
            self.assertIsNone(result["pii_count"])
            self.assertEqual(result["pii_risk_level"], "none")
        finally:
            path.unlink(missing_ok=True)

    def test_oversized_document_returns_null_pii_fields(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = Path(f.name)
        try:
            _make_pdf(str(path), "some content")
            oversized = MAX_DOCUMENT_SIZE_BYTES + 1
            with mock.patch(
                "analyzers.document_extractor.os.path.getsize",
                return_value=oversized,
            ):
                result = _run_pii_analysis(self.config, path, "application/pdf", ".pdf")
            self.assertIsNone(result["has_pii"])
            self.assertIsNone(result["pii_count"])
            self.assertEqual(result["pii_risk_level"], "none")
        finally:
            path.unlink(missing_ok=True)

    def test_pii_analysis_image_only_skips_documents(self):
        cfg = _minimal_config(enable_pii_analysis=True, pii_analysis_image_only=True)
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            path = Path(f.name)
        try:
            _make_pdf(str(path), "SSN: 123-45-6789")
            result = _run_pii_analysis(cfg, path, "application/pdf", ".pdf")
            self.assertIsNone(result["has_pii"])
            self.assertIsNone(result["pii_count"])
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
