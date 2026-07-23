"""
Analyzers package for PII detection and sensitivity classification.

Provides modular, swappable analyzers that run inside the dataset-import job
so sensitive data never leaves the cluster.

Modules:
    pii                  – Text PII detection via Presidio Analyzer (+ optional GLiNER).
    image_pii            – PII detection in images via OCR + Presidio.
    sensitivity          – Image sensitivity classification (sensitive / public / unknown).
    document_extractor   – Plain-text extraction from PDF, DOCX, and PPTX files.
"""

from analyzers.pii import analyze_text, PiiResult, get_risk_level, highest_risk_level, PII_RISK_LEVELS
from analyzers.image_pii import analyze_image, ImagePiiResult
from analyzers.sensitivity import classify_image, SensitivityResult
from analyzers.document_extractor import extract_document_text

__all__ = [
    "analyze_text",
    "PiiResult",
    "get_risk_level",
    "highest_risk_level",
    "PII_RISK_LEVELS",
    "analyze_image",
    "ImagePiiResult",
    "classify_image",
    "SensitivityResult",
    "extract_document_text",
]
