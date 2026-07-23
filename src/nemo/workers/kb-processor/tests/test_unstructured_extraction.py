from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data_sources.unstructured import UnstructuredDataSource


def _make_source(tmp_path: Path) -> UnstructuredDataSource:
    return UnstructuredDataSource(
        dataset_id="dataset",
        temp_dir=tmp_path,
    )


def test_text_extensions_include_new_binary_formats(tmp_path: Path):
    source = _make_source(tmp_path)
    assert ".pdf" in source.TEXT_EXTENSIONS
    assert ".docx" in source.TEXT_EXTENSIONS
    assert ".odt" in source.TEXT_EXTENSIONS
    assert ".doc" in source.TEXT_EXTENSIONS
    assert ".rtf" in source.TEXT_EXTENSIONS
    assert ".tex" in source.TEXT_EXTENSIONS
    assert ".adoc" in source.TEXT_EXTENSIONS
    assert ".asciidoc" in source.TEXT_EXTENSIONS
    assert ".org" in source.TEXT_EXTENSIONS
    assert ".xlsx" in source.TEXT_EXTENSIONS
    assert ".xls" in source.TEXT_EXTENSIONS


def test_extract_text_plain_file(tmp_path: Path):
    source = _make_source(tmp_path)
    file_path = tmp_path / "example.txt"
    file_path.write_text("hello\r\nworld\n", encoding="utf-8")
    assert source._extract_text(file_path) == "hello\nworld"


def test_sniff_pdf_with_wrong_extension(tmp_path: Path):
    pypdf = pytest.importorskip("pypdf")
    source = _make_source(tmp_path)

    pdf_path = tmp_path / "renamed.bin"
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with pdf_path.open("wb") as out:
        writer.write(out)

    assert source._guess_suffix_from_mime(pdf_path) == ".pdf"


def test_skip_encrypted_pdf(tmp_path: Path):
    pypdf = pytest.importorskip("pypdf")
    source = _make_source(tmp_path)

    pdf_path = tmp_path / "encrypted.pdf"
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt("secret")
    with pdf_path.open("wb") as out:
        writer.write(out)

    assert source._extract_text(pdf_path) == ""


def test_sniff_pptx_with_wrong_extension(tmp_path: Path):
    pptx = pytest.importorskip("pptx")
    source = _make_source(tmp_path)

    path = tmp_path / "renamed.bin"
    prs = pptx.Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "Sniff title"
    prs.save(str(path))

    assert source._guess_suffix_from_mime(path) == ".pptx"


def test_extract_pptx_text(tmp_path: Path):
    pptx = pytest.importorskip("pptx")
    source = _make_source(tmp_path)

    path = tmp_path / "sample.pptx"
    prs = pptx.Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "Quarterly results"
    slide.placeholders[1].text = "Revenue grew 12% year over year"
    table = slide.shapes.add_table(1, 2, 0, 0, 100, 50).table
    table.rows[0].cells[0].text = "Region"
    table.rows[0].cells[1].text = "APAC"
    prs.save(str(path))

    text = source._extract_text(path)
    assert "Quarterly results" in text
    assert "Revenue grew 12% year over year" in text
    assert "Region | APAC" in text
    assert "PK\x03\x04" not in text
    assert "ppt/fonts" not in text


def test_pptx_binary_fallback_skipped(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "corrupt.pptx"
    path.write_bytes(b"PK\x03\x04" + b"\x00" * 64)

    text = source._extract_text(path)
    assert text == ""


def test_extract_docx_text(tmp_path: Path):
    docx = pytest.importorskip("docx")
    source = _make_source(tmp_path)

    path = tmp_path / "sample.docx"
    doc = docx.Document()
    doc.add_paragraph("hello from docx")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "left"
    table.rows[0].cells[1].text = "right"
    doc.save(str(path))

    text = source._extract_text(path)
    assert "hello from docx" in text
    assert "left | right" in text


def test_extract_xlsx_text(tmp_path: Path):
    openpyxl = pytest.importorskip("openpyxl")
    source = _make_source(tmp_path)

    path = tmp_path / "sample.xlsx"
    workbook = openpyxl.Workbook()
    sheet_one = workbook.active
    sheet_one.title = "Summary"
    sheet_one["A1"] = "Region"
    sheet_one["B1"] = "Revenue"
    sheet_one["A2"] = "APAC"
    sheet_one["B2"] = 1200000

    sheet_two = workbook.create_sheet("Details")
    sheet_two["A1"] = "Quarter"
    sheet_two["B1"] = "Growth"
    sheet_two["A2"] = "Q1"
    sheet_two["B2"] = "12%"
    workbook.save(str(path))
    workbook.close()

    text = source._extract_text(path)
    assert "# Summary" in text
    assert "# Details" in text
    assert "Region\tRevenue" in text
    assert "APAC\t1200000" in text
    assert "Quarter\tGrowth" in text
    assert "Q1\t12%" in text


def test_xlsx_binary_fallback_skipped(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "corrupt.xlsx"
    path.write_bytes(b"PK\x03\x04" + b"\x00" * 64)

    text = source._extract_text(path)
    assert text == ""


def test_sniff_xlsx_with_wrong_extension(tmp_path: Path):
    openpyxl = pytest.importorskip("openpyxl")
    source = _make_source(tmp_path)

    path = tmp_path / "renamed.bin"
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Sheet1"
    sheet["A1"] = "Sniff value"
    workbook.save(str(path))
    workbook.close()

    assert source._guess_suffix_from_mime(path) == ".xlsx"


def test_extract_xls_text(tmp_path: Path):
    xlwt = pytest.importorskip("xlwt")
    source = _make_source(tmp_path)

    path = tmp_path / "sample.xls"
    workbook = xlwt.Workbook()
    sheet_one = workbook.add_sheet("Summary")
    sheet_one.write(0, 0, "Region")
    sheet_one.write(0, 1, "Revenue")
    sheet_one.write(1, 0, "EMEA")
    sheet_one.write(1, 1, "900000")

    sheet_two = workbook.add_sheet("Details")
    sheet_two.write(0, 0, "Quarter")
    sheet_two.write(0, 1, "Growth")
    sheet_two.write(1, 0, "Q2")
    sheet_two.write(1, 1, "8%")
    workbook.save(str(path))

    text = source._extract_text(path)
    assert "# Summary" in text
    assert "# Details" in text
    assert "Region\tRevenue" in text
    assert "EMEA\t900000" in text
    assert "Quarter\tGrowth" in text
    assert "Q2\t8%" in text


def test_extract_odt_text(tmp_path: Path):
    odf_text = pytest.importorskip("odf.text")
    odf_doc = pytest.importorskip("odf.opendocument")
    source = _make_source(tmp_path)

    path = tmp_path / "sample.odt"
    doc = odf_doc.OpenDocumentText()
    doc.text.addElement(odf_text.P(text="hello from odt"))
    doc.save(str(path))

    text = source._extract_text(path)
    assert "hello from odt" in text


def test_doc_is_explicitly_unsupported(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "legacy.doc"
    path.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
    assert source._extract_text(path) == ""


def test_extract_rtf_strips_markup_and_keeps_text(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "sample.rtf"
    path.write_text(
        r"{\rtf1\ansi\deff0 {\fonttbl {\f0 Arial;}}\pard hello\par world \tab cell\par unicode: \u945?\par}",
        encoding="utf-8",
    )
    text = source._extract_text(path)
    assert "hello" in text
    assert "world" in text
    assert "unicode: α" in text


def test_sniff_rtf_with_wrong_extension(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "renamed.bin"
    path.write_text(r"{\rtf1\ansi sample\par text}", encoding="utf-8")
    assert source._guess_suffix_from_mime(path) == ".rtf"
    assert "sample" in source._extract_text(path)


def test_extract_rtf_corrupt_is_non_fatal(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "corrupt.rtf"
    path.write_bytes(b"\x00\xff\x00\xff")
    text = source._extract_text(path)
    assert isinstance(text, str)


@pytest.mark.parametrize("name", ["doc.tex", "guide.adoc", "guide.asciidoc", "notes.org"])
def test_text_doc_extensions_use_text_path(tmp_path: Path, name: str):
    source = _make_source(tmp_path)
    path = tmp_path / name
    path.write_text("line one\nline two\n", encoding="utf-8")
    assert source._extract_text(path) == "line one\nline two"


def test_extract_markdown_and_csv(tmp_path: Path):
    source = _make_source(tmp_path)

    md_path = tmp_path / "readme.md"
    md_path.write_text("# Title\n\nBody line.", encoding="utf-8")
    assert "Title" in source._extract_text(md_path)

    csv_path = tmp_path / "data.csv"
    csv_path.write_text("col1,col2\nval1,val2\n", encoding="utf-8")
    csv_text = source._extract_text(csv_path)
    assert "col1 col2" in csv_text
    assert "val1 val2" in csv_text


def test_corrupt_binary_returns_empty_without_exception(tmp_path: Path):
    source = _make_source(tmp_path)
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"not-a-real-pdf")
    text = source._extract_text(path)
    assert text == ""


@pytest.mark.parametrize("ext", [".ppt", ".pptx"])
def test_ppt_extensions_not_in_supported_text_extensions(tmp_path: Path, ext: str):
    source = _make_source(tmp_path)
    assert ext not in source.TEXT_EXTENSIONS


def test_list_dataset_files_skips_ppt_and_parquet(monkeypatch, tmp_path: Path):
    mount = tmp_path / "store"
    data_dir = mount / "datasets/dataset/data_files"
    data_dir.mkdir(parents=True)
    (data_dir / "slides.pptx").write_bytes(b"PK\x03\x04fake")
    (data_dir / "table.parquet").write_bytes(b"PAR1")
    (data_dir / "report.xlsx").write_bytes(b"PK\x03\x04fake")
    (data_dir / "readme.txt").write_text("indexed text", encoding="utf-8")

    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(mount))
    source = _make_source(tmp_path / "work")
    source.connect()

    assert sorted(source._files) == sorted([
        "datasets/dataset/data_files/readme.txt",
        "datasets/dataset/data_files/report.xlsx",
    ])


def test_extract_pptx_has_no_dedicated_parser(tmp_path: Path):
    """PPT/PPTX are not first-class parse targets; extraction is not slide-aware."""
    source = _make_source(tmp_path)
    path = tmp_path / "deck.pptx"
    path.write_bytes(b"PK\x03\x04" + b"\x00" * 64)
    text = source._extract_text(path)
    assert isinstance(text, str)
    # No python-pptx / OOXML path — do not expect clean slide copy.
    assert "Slide 1 title" not in text


def test_extract_parquet_not_structured_document_parse(tmp_path: Path):
    """Parquet as KB source file is unsupported; column text must use structured datasets."""
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")

    source = _make_source(tmp_path)
    path = tmp_path / "rows.parquet"
    pq.write_table(
        pa.table({"title": ["SecretTitle"], "body": ["SecretBody"]}),
        path,
    )

    text = source._extract_text(path)
    assert "title: SecretTitle" not in text
    assert "body: SecretBody" not in text


@pytest.mark.skip(
    reason="PPT/PPTX slide-aware extraction not implemented in UnstructuredDataSource"
)
def test_extract_pptx_slide_text():
    """TODO: implement OOXML/PPT parser and assert slide text is extracted."""
    pytest.fail("Implement PPT/PPTX parser")


@pytest.mark.skip(
    reason="Parquet document ingestion not implemented; use StructuredDataSource / Iceberg"
)
def test_extract_parquet_columns_as_document_text():
    """TODO: parse Parquet rows into Document content when product adds unstructured Parquet."""
    pytest.fail("Implement Parquet document parsing")


def test_process_file_document_metadata(monkeypatch, tmp_path: Path):
    source = _make_source(tmp_path)
    file_key = "datasets/dataset/data_files/docs/readme.md"
    source.prefix = "datasets/dataset/data_files/"
    local_src = tmp_path / "readme.md"
    local_src.write_text("hello metadata", encoding="utf-8")

    def fake_posix_path(key):
        assert key == file_key
        return local_src

    monkeypatch.setattr("utils.data_store.posix_path", fake_posix_path)

    doc = source._process_file(file_key)
    assert doc is not None
    assert doc.metadata["file_name"] == "readme.md"
    assert doc.metadata["file_path"] == file_key
    assert doc.metadata["relative_path"] == "docs/readme.md"
    assert doc.metadata["source_type"] == "unstructured"
    assert doc.doc_id
    assert "hello metadata" in doc.content

