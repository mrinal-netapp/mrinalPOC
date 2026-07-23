"""
PII detection in images via OCR + Presidio.

Uses Presidio Image Redactor's underlying OCR pipeline (Tesseract) to
extract text from images and then runs Presidio Analyzer on the extracted
text.  This finds PII that is *burned into* images (e.g. scanned documents,
screenshots of forms containing SSNs/addresses).

Usage:
    from analyzers.image_pii import analyze_image
    result = analyze_image("/tmp/scan.png")
    # result.entities == ["US_SSN", "PERSON"]
    # result.count    == 2
"""

from observability_client_runtime import get_logger
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Union

from analyzers.pii import PiiResult, analyze_text

logger = get_logger()

# Lazy-loaded OCR engine
_ocr_engine = None


@dataclass
class ImagePiiResult(PiiResult):
    """PII result from image analysis – same shape as text PiiResult."""
    pass


def _get_ocr_engine():
    """Return a lazily-initialized Tesseract OCR engine."""
    global _ocr_engine
    if _ocr_engine is not None:
        return _ocr_engine

    try:
        from presidio_image_redactor import ImageAnalyzerEngine
        _ocr_engine = ImageAnalyzerEngine()
        logger.info("Presidio ImageAnalyzerEngine initialized successfully")
    except ImportError:
        logger.warning(
            "presidio-image-redactor not installed; image PII detection disabled"
        )
        _ocr_engine = None
    except Exception as exc:
        logger.error("Failed to init ImageAnalyzerEngine: %s", exc)
        _ocr_engine = None

    return _ocr_engine


def _extract_text_with_tesseract(image_path: str) -> str:
    """Extract text from an image using pytesseract directly as a fallback."""
    try:
        import pytesseract
        from PIL import Image

        img = Image.open(image_path)
        text = pytesseract.image_to_string(img)
        return text or ""
    except Exception as exc:
        logger.warning("Tesseract OCR fallback failed: %s", exc)
        return ""


def analyze_image(
    image_path: Union[str, Path],
    language: str = "en",
    score_threshold: float = 0.35,
) -> ImagePiiResult:
    """Detect PII entities in text burned into an image.

    Attempts Presidio ImageAnalyzerEngine first.  If that is unavailable,
    falls back to plain Tesseract OCR + text analysis.

    Args:
        image_path: Path to the image file.
        language: ISO-639-1 language code.
        score_threshold: Minimum confidence to accept.

    Returns:
        An :class:`ImagePiiResult` with entity types and count.
    """
    image_path = str(image_path)

    # --- Strategy 1: Presidio ImageAnalyzerEngine (OCR + Analyzer integrated) ---
    engine = _get_ocr_engine()
    if engine is not None:
        try:
            from PIL import Image

            img = Image.open(image_path)
            results = engine.analyze(
                img,
                language=language,
                score_threshold=score_threshold,
            )
            entities = [r.entity_type for r in results]
            return ImagePiiResult(entities=entities, count=len(entities))
        except Exception as exc:
            logger.warning(
                "Presidio image analysis failed for %s, falling back to OCR: %s",
                image_path,
                exc,
            )

    # --- Strategy 2: Fallback – raw Tesseract OCR + text analyzer ---
    extracted_text = _extract_text_with_tesseract(image_path)
    if extracted_text.strip():
        text_result = analyze_text(
            extracted_text,
            language=language,
            score_threshold=score_threshold,
        )
        return ImagePiiResult(entities=text_result.entities, count=text_result.count)

    return ImagePiiResult()
