"""Unstructured data source - reads files from POSIX mount."""

import csv
import json
from observability_client_runtime import get_logger
import mimetypes
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Iterator, List, Optional

from .base import DataSource, Document

logger = get_logger()


class UnstructuredDataSource(DataSource):
    """
    Data source for unstructured datasets.

    Reads files from the POSIX mount at [path_prefix/]datasets/{dataset_id}/data_files/
    and extracts text content from supported file types.
    Files may be directly under data_files/ or in subdirectories
    (e.g. data_files/dir1/file.txt) when whole directories are uploaded.
    """

    TEXT_EXTENSIONS = {
        '.txt', '.md', '.csv', '.json', '.jsonl', '.ndjson',
        '.html', '.htm', '.xml', '.yaml', '.yml', '.toml',
        '.ini', '.cfg', '.conf', '.properties', '.env',
        '.rst', '.log', '.tsv', '.pdf', '.docx', '.odt', '.doc',
        '.rtf', '.tex', '.adoc', '.asciidoc', '.org',
        '.xlsx', '.xls',
    }
    # Office/binary types must use structured extractors — never read as UTF-8.
    BINARY_NO_RAW_READ_EXTENSIONS = frozenset({
        '.pptx', '.ppt', '.parquet', '.doc', '.zip', '.gz', '.bz2',
    })
    MAX_PARSE_FILE_SIZE_BYTES = 50 * 1024 * 1024
    MAX_PDF_PAGES = 2000
    EXTRACTION_TIMEOUT_SECONDS = 30.0

    def __init__(
        self,
        dataset_id: str,
        s3_path_prefix: str = '',
        temp_dir: Optional[Path] = None,
        file_keys: Optional[List[str]] = None,
    ):
        self.dataset_id = dataset_id
        base = f"{s3_path_prefix}/datasets/{dataset_id}/data_files/" if s3_path_prefix else f"datasets/{dataset_id}/data_files/"
        self.prefix = base
        self.temp_dir = temp_dir or Path('/tmp/kb-processor')
        self._file_keys_filter: Optional[List[str]] = file_keys
        self._files: List[str] = []

    def connect(self) -> None:
        """List files from S3 (or use partition file_keys) and prepare for processing."""
        if self._file_keys_filter:
            # Partition path: only process files in the manifest; skip S3 listing
            self._files = list(self._file_keys_filter)
            self.temp_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"Connected to unstructured source with {len(self._files)} files (partition manifest)")
        else:
            self._files = self._list_dataset_files()
            self.temp_dir.mkdir(parents=True, exist_ok=True)
            logger.info(f"Connected to unstructured source with {len(self._files)} files")

    def _list_dataset_files(self) -> List[str]:
        """List all files in the dataset prefix on the POSIX mount."""
        from utils.data_store import default_store_root

        mount = default_store_root()
        base = Path(mount) / self.prefix
        files = []
        skipped = []
        if base.is_dir():
            for p in sorted(base.rglob("*")):
                if p.is_file():
                    fname = p.name
                    if fname.startswith('.') or 'result' in fname:
                        continue
                    ext = p.suffix.lower()
                    key = f"{self.prefix}{p.relative_to(base)}"
                    if ext in self.TEXT_EXTENSIONS or ext == '':
                        files.append(key)
                    else:
                        skipped.append(key)
        if skipped:
            logger.info("Skipped %d files with unsupported extensions: %s%s",
                        len(skipped), ', '.join(skipped[:10]),
                        '...' if len(skipped) > 10 else '')
        logger.info("Found %d files under %s", len(files), base)
        return files

    def get_documents(self) -> Iterator[Document]:
        """Yield documents from S3 files, logging each file at INFO level."""
        total = len(self._files)
        process_start = time.monotonic()

        for idx, file_key in enumerate(self._files, 1):
            file_start = time.monotonic()
            try:
                doc = self._process_file(file_key)
                file_elapsed = time.monotonic() - file_start
                if doc:
                    content_len = len(doc.content) if doc.content else 0
                    logger.info(
                        f"[file {idx}/{total}] "
                        f"Downloaded & extracted '{file_key}' "
                        f"({content_len} chars) in {file_elapsed:.2f}s"
                    )
                    yield doc
                else:
                    logger.info(
                        f"[file {idx}/{total}] "
                        f"Skipped '{file_key}' (no text extracted) "
                        f"after {file_elapsed:.2f}s"
                    )
            except Exception as e:
                file_elapsed = time.monotonic() - file_start
                logger.warning(
                    f"[file {idx}/{total}] "
                    f"Error processing '{file_key}' after {file_elapsed:.2f}s: {e}"
                )
                continue

        total_elapsed = time.monotonic() - process_start
        logger.info(
            f"Finished processing all {total} files in {total_elapsed:.1f}s "
            f"({total / total_elapsed:.1f} files/s)" if total_elapsed > 0 else
            f"Finished processing all {total} files"
        )

    def _process_file(self, file_key: str) -> Optional[Document]:
        """Download and extract text from a single file."""
        file_name = Path(file_key).name
        # Derive the path relative to the data_files/ prefix for display and
        # to avoid local filename collisions when files from different
        # subdirectories share the same basename (e.g. dir1/readme.txt,
        # dir2/readme.txt).
        relative_path = file_key
        if self.prefix and self.prefix in file_key:
            relative_path = file_key[len(self.prefix):]
        # Create local subdirectory structure to avoid collisions
        local_path = self.temp_dir / relative_path
        local_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            from utils.data_store import posix_path
            src = posix_path(file_key)
            shutil.copy2(str(src), str(local_path))
            logger.debug("Loaded %s from %s", file_key, src)

            # Extract text
            text = self._extract_text(local_path)

            if not text:
                logger.warning(f"No text extracted from {file_key}")
                return None

            # Create document
            doc_id = str(uuid.uuid4())
            metadata = {
                'file_path': file_key,
                'file_name': file_name,
                'relative_path': relative_path,
                'source_type': 'unstructured',
            }

            return Document(doc_id=doc_id, content=text, metadata=metadata)

        finally:
            # Clean up local file
            if local_path.exists():
                local_path.unlink()

    def _extract_text(self, file_path: Path) -> str:
        """Extract text content from different file types."""
        suffix = file_path.suffix.lower()
        start = time.monotonic()
        if self._is_file_too_large(file_path):
            return ""

        try:
            effective_suffix = suffix or self._guess_suffix_from_mime(file_path)

            if effective_suffix in ('.txt', '.md', '.rst', '.log', ''):
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    return self._normalize_text(f.read())

            elif effective_suffix == '.csv':
                lines = []
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    reader = csv.reader(f)
                    for row in reader:
                        lines.append(' '.join(row))
                return self._normalize_text('\n'.join(lines))

            elif effective_suffix == '.tsv':
                lines = []
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    reader = csv.reader(f, delimiter='\t')
                    for row in reader:
                        lines.append(' '.join(row))
                return self._normalize_text('\n'.join(lines))

            elif effective_suffix in ('.json', '.jsonl', '.ndjson'):
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                # For JSON, try to pretty-print for better chunking
                try:
                    parsed = json.loads(content)
                    return self._normalize_text(json.dumps(parsed, indent=2, ensure_ascii=False))
                except json.JSONDecodeError:
                    return self._normalize_text(content)  # Return raw content for JSONL/malformed JSON

            elif effective_suffix in ('.html', '.htm', '.xml'):
                # Read as text; HTML/XML tags will be included but chunker handles it
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    return self._normalize_text(f.read())

            elif effective_suffix in ('.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
                                      '.properties', '.env'):
                # Configuration/markup files - read as plain text
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    return self._normalize_text(f.read())

            elif effective_suffix == '.pdf':
                return self._extract_pdf_text(file_path, start)

            elif effective_suffix == '.docx':
                return self._extract_docx_text(file_path, start)

            elif effective_suffix == '.odt':
                return self._extract_odt_text(file_path, start)

            elif effective_suffix == '.doc':
                return self._extract_doc_text(file_path)

            elif effective_suffix == '.rtf':
                return self._extract_rtf_text(file_path)

            elif effective_suffix == '.pptx':
                return self._extract_pptx_text(file_path, start)

            elif effective_suffix in ('.xlsx', '.xls'):
                return self._extract_xlsx_text(file_path, start)

            else:
                if effective_suffix in self.BINARY_NO_RAW_READ_EXTENSIONS:
                    logger.warning(
                        "No structured extractor for %s (%s); skipping instead of raw read",
                        file_path.name,
                        effective_suffix,
                    )
                    return ""
                # Attempt to read as text for any other extension
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        return self._normalize_text(f.read())
                except Exception:
                    logger.warning(f"Cannot read file as text: {file_path.name}")
                    return ""

        except Exception as e:
            logger.error(f"Failed to extract text from {file_path}: {e}")
            return ""

    def _is_file_too_large(self, file_path: Path) -> bool:
        """Skip oversized files for extraction safety."""
        try:
            size = file_path.stat().st_size
            if size > self.MAX_PARSE_FILE_SIZE_BYTES:
                logger.warning(
                    "Skipping file due to size limit: %s (%d bytes > %d bytes)",
                    file_path.name,
                    size,
                    self.MAX_PARSE_FILE_SIZE_BYTES,
                )
                return True
        except OSError:
            return False
        return False

    def _guess_suffix_from_mime(self, file_path: Path) -> str:
        """Best-effort MIME/content-based mapping for renamed files."""
        sniffed = self._sniff_binary_type(file_path)
        if sniffed:
            return sniffed

        guessed_mime, _ = mimetypes.guess_type(str(file_path))
        if guessed_mime == 'application/pdf':
            return '.pdf'
        if guessed_mime in (
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/msword',
        ):
            return '.docx'
        if guessed_mime == 'application/vnd.oasis.opendocument.text':
            return '.odt'
        if guessed_mime == 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return '.pptx'
        if guessed_mime == 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
            return '.xlsx'
        if guessed_mime == 'application/vnd.ms-excel':
            return '.xls'
        if guessed_mime == 'application/rtf':
            return '.rtf'
        if guessed_mime == 'text/rtf':
            return '.rtf'
        return ''

    def _sniff_binary_type(self, file_path: Path) -> str:
        """Detect known binary document formats from file signatures."""
        try:
            with open(file_path, 'rb') as f:
                header = f.read(2048)
        except OSError:
            return ''

        # PDF files always start with %PDF
        if header.startswith(b'%PDF'):
            return '.pdf'

        # DOCX/ODT are zip-based, inspect container entries quickly.
        if header.startswith(b'PK\x03\x04'):
            try:
                import zipfile
                with zipfile.ZipFile(file_path) as archive:
                    names = set(archive.namelist())
                if 'word/document.xml' in names:
                    return '.docx'
                if 'ppt/presentation.xml' in names:
                    return '.pptx'
                if 'xl/workbook.xml' in names:
                    return '.xlsx'
                if 'content.xml' in names and 'mimetype' in names:
                    return '.odt'
            except Exception:
                return ''

        # RTF signature usually starts with "{\rtf" (optionally with BOM/whitespace)
        stripped = header.lstrip(b"\xef\xbb\xbf \t\r\n")
        if stripped.startswith(b"{\\rtf"):
            return '.rtf'
        return ''

    def _normalize_text(self, content: str) -> str:
        """Normalize extracted text to keep chunking behavior consistent."""
        if not content:
            return ""
        normalized = content.replace('\r\n', '\n').replace('\r', '\n').strip()
        return normalized

    def _timed_out(self, started_at: float) -> bool:
        return (time.monotonic() - started_at) > self.EXTRACTION_TIMEOUT_SECONDS

    def _extract_pdf_text(self, file_path: Path, started_at: float) -> str:
        try:
            from pypdf import PdfReader
        except ImportError:
            logger.warning("pypdf is not installed; skipping PDF extraction for %s", file_path.name)
            return ""

        try:
            reader = PdfReader(str(file_path))
            if reader.is_encrypted:
                logger.warning("Skipping encrypted PDF: %s", file_path.name)
                return ""

            texts: List[str] = []
            for idx, page in enumerate(reader.pages):
                if idx >= self.MAX_PDF_PAGES:
                    logger.warning("Reached max PDF page limit for %s", file_path.name)
                    break
                if self._timed_out(started_at):
                    logger.warning("Timed out extracting PDF %s after %ss", file_path.name, self.EXTRACTION_TIMEOUT_SECONDS)
                    break
                page_text = page.extract_text() or ""
                if page_text.strip():
                    texts.append(page_text)
            return self._normalize_text('\n\n'.join(texts))
        except Exception as exc:
            logger.warning("Failed PDF extraction for %s: %s", file_path.name, exc)
            return ""

    def _extract_docx_text(self, file_path: Path, started_at: float) -> str:
        try:
            from docx import Document as DocxDocument
        except ImportError:
            logger.warning("python-docx is not installed; skipping DOCX extraction for %s", file_path.name)
            return ""

        try:
            doc = DocxDocument(str(file_path))
            parts: List[str] = []

            for paragraph in doc.paragraphs:
                if self._timed_out(started_at):
                    logger.warning("Timed out extracting DOCX %s after %ss", file_path.name, self.EXTRACTION_TIMEOUT_SECONDS)
                    break
                text = paragraph.text.strip()
                if text:
                    parts.append(text)

            for table in doc.tables:
                if self._timed_out(started_at):
                    logger.warning("Timed out extracting DOCX tables %s", file_path.name)
                    break
                for row in table.rows:
                    row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text and cell.text.strip())
                    if row_text:
                        parts.append(row_text)

            return self._normalize_text('\n'.join(parts))
        except Exception as exc:
            logger.warning("Failed DOCX extraction for %s: %s", file_path.name, exc)
            return ""

    def _extract_xlsx_text(self, file_path: Path, started_at: float) -> str:
        suffix = file_path.suffix.lower()
        if suffix == '.xls':
            return self._extract_xls_text(file_path, started_at)

        try:
            from openpyxl import load_workbook
        except ImportError:
            logger.warning(
                "openpyxl is not installed; skipping XLSX extraction for %s",
                file_path.name,
            )
            return ""

        workbook = None
        try:
            workbook = load_workbook(str(file_path), read_only=True, data_only=True)
            parts: List[str] = []

            for sheet in workbook:
                if self._timed_out(started_at):
                    logger.warning(
                        "Timed out extracting XLSX %s after %ss",
                        file_path.name,
                        self.EXTRACTION_TIMEOUT_SECONDS,
                    )
                    break
                parts.append(f"# {sheet.title}")
                for row in sheet.iter_rows(values_only=True):
                    if self._timed_out(started_at):
                        logger.warning(
                            "Timed out extracting XLSX rows %s",
                            file_path.name,
                        )
                        break
                    cells = [
                        str(cell).strip()
                        for cell in row
                        if cell is not None and str(cell).strip()
                    ]
                    if cells:
                        parts.append('\t'.join(cells))

            return self._normalize_text('\n'.join(parts))
        except Exception as exc:
            logger.warning("Failed XLSX extraction for %s: %s", file_path.name, exc)
            return ""
        finally:
            if workbook is not None:
                workbook.close()

    def _extract_xls_text(self, file_path: Path, started_at: float) -> str:
        try:
            import xlrd
        except ImportError:
            logger.warning(
                "xlrd is not installed; skipping XLS extraction for %s",
                file_path.name,
            )
            return ""

        try:
            book = xlrd.open_workbook(str(file_path))
            parts: List[str] = []

            for sheet in book.sheets():
                if self._timed_out(started_at):
                    logger.warning(
                        "Timed out extracting XLS %s after %ss",
                        file_path.name,
                        self.EXTRACTION_TIMEOUT_SECONDS,
                    )
                    break
                parts.append(f"# {sheet.name}")
                for row_idx in range(sheet.nrows):
                    if self._timed_out(started_at):
                        logger.warning(
                            "Timed out extracting XLS rows %s",
                            file_path.name,
                        )
                        break
                    cells = [
                        str(cell).strip()
                        for cell in sheet.row_values(row_idx)
                        if cell is not None and str(cell).strip()
                    ]
                    if cells:
                        parts.append('\t'.join(cells))

            return self._normalize_text('\n'.join(parts))
        except Exception as exc:
            logger.warning("Failed XLS extraction for %s: %s", file_path.name, exc)
            return ""

    def _pptx_shape_text_parts(self, shapes, started_at: float) -> List[str]:
        """Collect text from slide shapes, including grouped shapes and tables."""
        try:
            from pptx.enum.shapes import MSO_SHAPE_TYPE
        except ImportError:
            return []

        parts: List[str] = []
        for shape in shapes:
            if self._timed_out(started_at):
                break
            if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                parts.extend(self._pptx_shape_text_parts(shape.shapes, started_at))
            elif getattr(shape, 'has_text_frame', False):
                text = (shape.text or '').strip()
                if text:
                    parts.append(text)
            elif getattr(shape, 'has_table', False):
                for row in shape.table.rows:
                    if self._timed_out(started_at):
                        break
                    row_text = ' | '.join(
                        cell.text.strip()
                        for cell in row.cells
                        if cell.text and cell.text.strip()
                    )
                    if row_text:
                        parts.append(row_text)
        return parts

    def _extract_pptx_text(self, file_path: Path, started_at: float) -> str:
        try:
            from pptx import Presentation
        except ImportError:
            logger.warning(
                "python-pptx is not installed; skipping PPTX extraction for %s",
                file_path.name,
            )
            return ""

        try:
            prs = Presentation(str(file_path))
            parts: List[str] = []

            for slide in prs.slides:
                if self._timed_out(started_at):
                    logger.warning(
                        "Timed out extracting PPTX %s after %ss",
                        file_path.name,
                        self.EXTRACTION_TIMEOUT_SECONDS,
                    )
                    break
                parts.extend(self._pptx_shape_text_parts(slide.shapes, started_at))
                notes_slide = getattr(slide, 'notes_slide', None)
                if notes_slide is not None:
                    notes_frame = notes_slide.notes_text_frame
                    if notes_frame is not None:
                        notes_text = (notes_frame.text or '').strip()
                        if notes_text:
                            parts.append(notes_text)

            return self._normalize_text('\n'.join(parts))
        except Exception as exc:
            logger.warning("Failed PPTX extraction for %s: %s", file_path.name, exc)
            return ""

    def _extract_odt_text(self, file_path: Path, started_at: float) -> str:
        try:
            from odf.opendocument import load as odf_load
            from odf import text as odf_text
            from odf import teletype
        except ImportError:
            logger.warning("odfpy is not installed; skipping ODT extraction for %s", file_path.name)
            return ""

        try:
            doc = odf_load(str(file_path))
            parts: List[str] = []
            paragraphs = doc.getElementsByType(odf_text.P)
            for para in paragraphs:
                if self._timed_out(started_at):
                    logger.warning("Timed out extracting ODT %s after %ss", file_path.name, self.EXTRACTION_TIMEOUT_SECONDS)
                    break
                text = teletype.extractText(para).strip()
                if text:
                    parts.append(text)
            return self._normalize_text('\n'.join(parts))
        except Exception as exc:
            logger.warning("Failed ODT extraction for %s: %s", file_path.name, exc)
            return ""

    def _extract_doc_text(self, file_path: Path) -> str:
        """Legacy .doc fallback is intentionally unsupported in v1."""
        logger.warning(
            "Legacy .doc extraction is not supported in v1 for %s; "
            "consider converting to .docx before upload",
            file_path.name,
        )
        return ""

    def _extract_rtf_text(self, file_path: Path) -> str:
        """Extract readable text from RTF with conservative markup stripping."""
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except Exception as exc:
            logger.warning("Failed to read RTF file %s: %s", file_path.name, exc)
            return ""

        if not content.strip():
            return ""

        try:
            text = content
            # Normalize common structural control words before stripping others.
            text = re.sub(r'\\par[d]?\\?', '\n', text)
            text = re.sub(r'\\line\\?', '\n', text)
            text = re.sub(r'\\tab\\?', '\t', text)
            text = re.sub(r'\\cell\\?', ' | ', text)
            text = re.sub(r'\\row\\?', '\n', text)

            # Decode unicode escapes (\uN?) before removing control words.
            def _decode_unicode(match):
                try:
                    value = int(match.group(1))
                    if value < 0:
                        value += 65536
                    return chr(value)
                except Exception:
                    return ''

            text = re.sub(r'\\u(-?\d+)\??', _decode_unicode, text)
            text = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes.fromhex(m.group(1)).decode('latin-1'), text)

            # Remove destinations (e.g. fonttbl, colortbl, metadata).
            text = re.sub(r'\{\\\*[^{}]*\}', ' ', text)
            text = re.sub(
                r'\{\\(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer)[^{}]*\}',
                ' ',
                text,
                flags=re.IGNORECASE,
            )

            # Drop remaining control words/symbols and braces.
            text = re.sub(r'\\[a-zA-Z]+\d* ?', ' ', text)
            text = re.sub(r'\\[^a-zA-Z0-9]', ' ', text)
            text = text.replace('{', ' ').replace('}', ' ')

            # Collapse whitespace while preserving newlines.
            text = re.sub(r'[ \t]+', ' ', text)
            text = re.sub(r'\n{3,}', '\n\n', text)
            return self._normalize_text(text)
        except Exception as exc:
            logger.warning("Failed to parse RTF content in %s: %s", file_path.name, exc)
            # Last resort: normalized plain read.
            return self._normalize_text(content)

    def get_total_count(self) -> int:
        """Get total number of files."""
        return len(self._files)

    @property
    def source_type(self) -> str:
        """Return 'unstructured'."""
        return 'unstructured'
