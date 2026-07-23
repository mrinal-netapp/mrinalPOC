"""
Text PII detection using Microsoft Presidio Analyzer.

Detects SSN, addresses, names, email, phone, credit card, and other PII
entity types in text content.  Optionally supports GLiNER as an additional
NER recognizer for improved recall on free-text entities.

Usage:
    from analyzers.pii import analyze_text
    result = analyze_text("John's SSN is 123-45-6789")
    # result.entities == ["US_SSN", "PERSON"]
    # result.count    == 2
"""

import json
from observability_client_runtime import get_logger
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = get_logger()

# Maximum text size to analyze (5 MB) to avoid OOM on very large files.
MAX_TEXT_SIZE_BYTES = 5 * 1024 * 1024

# Maximum characters per chunk for spaCy's NLP pipeline.
# spaCy needs ~1 GB of temporary memory per 100K characters.  With a 4 Gi
# container limit and ~1-1.5 GB baseline (spaCy model + runtime), 100K chars
# per chunk keeps peak memory well within budget while still scanning the
# full document via chunking.
CHUNK_MAX_CHARS = 100_000

# ---------------------------------------------------------------------------
# PII risk-level classification
# ---------------------------------------------------------------------------
# Maps Presidio entity types to a risk tier.  Entities not listed here
# default to "medium" (safe assumption for unknown / custom recognizers).

PII_RISK_LEVELS: Dict[str, str] = {
    # HIGH -- directly identifies a person or enables identity theft / fraud
    "US_SSN": "high",
    "US_DRIVER_LICENSE": "high",
    "US_PASSPORT": "high",
    "US_BANK_NUMBER": "high",
    "CREDIT_CARD": "high",
    "IBAN_CODE": "high",
    "US_ITIN": "high",
    "MEDICAL_LICENSE": "high",
    "UK_NHS": "high",
    "SG_NRIC_FIN": "high",
    "AU_TFN": "high",
    "AU_MEDICARE": "high",
    "IN_AADHAAR": "high",
    "IN_PAN": "high",
    "IP_ADDRESS": "high",
    "CRYPTO": "high",
    # MEDIUM -- personal identifiers that need context to cause harm
    "PERSON": "medium",
    "EMAIL_ADDRESS": "medium",
    "PHONE_NUMBER": "medium",
    "LOCATION": "medium",
    "NRP": "medium",
    # LOW -- commonly occurring values that are rarely PII risks on their own
    "DATE_TIME": "low",
    "URL": "low",
    "DOMAIN_NAME": "low",
    "ORGANIZATION": "low",
    "TITLE": "low",
}

_RISK_ORDERING = {"high": 3, "medium": 2, "low": 1, "none": 0}


def get_risk_level(entity_type: str) -> str:
    """Return the risk tier for a single Presidio entity type."""
    return PII_RISK_LEVELS.get(entity_type, "medium")


def highest_risk_level(entities: List[str]) -> str:
    """Return the highest risk tier present in *entities* (high > medium > low > none)."""
    if not entities:
        return "none"
    best = 0
    for e in entities:
        level = get_risk_level(e)
        rank = _RISK_ORDERING.get(level, 2)
        if rank > best:
            best = rank
        if best == 3:
            break  # can't go higher
    for name, rank in _RISK_ORDERING.items():
        if rank == best:
            return name
    return "none"

# ---------------------------------------------------------------------------

# Lazy-loaded singleton so the heavy NLP model is only loaded once per process.
_analyzer_engine = None

# Track whether optional GLiNER recognizer is available
_gliner_recognizer_loaded = False


@dataclass
class PiiResult:
    """Result of PII analysis on a text document."""
    entities: List[str] = field(default_factory=list)
    count: int = 0
    risk_level: str = "none"
    high_risk_count: int = 0
    medium_risk_count: int = 0
    low_risk_count: int = 0

    def to_json(self) -> str:
        """Serialize entity list to a JSON string for Iceberg storage."""
        return json.dumps(sorted(set(self.entities)))


def _get_analyzer():
    """Return a lazily-initialized AnalyzerEngine singleton."""
    global _analyzer_engine, _gliner_recognizer_loaded

    if _analyzer_engine is not None:
        return _analyzer_engine

    try:
        from presidio_analyzer import AnalyzerEngine
        _analyzer_engine = AnalyzerEngine()
        logger.info("Presidio AnalyzerEngine initialized successfully")
    except Exception as exc:
        logger.error("Failed to initialize Presidio AnalyzerEngine: %s", exc)
        raise

    # Optionally add GLiNER-based recognizer for better NER recall
    if not _gliner_recognizer_loaded:
        try:
            from analyzers._gliner_recognizer import GlinerRecognizer
            gliner_rec = GlinerRecognizer()
            _analyzer_engine.registry.add_recognizer(gliner_rec)
            _gliner_recognizer_loaded = True
            logger.info("GLiNER recognizer added to Presidio AnalyzerEngine")
        except ImportError:
            logger.debug("GLiNER recognizer not available (optional dependency)")
        except Exception as exc:
            logger.warning("Failed to load GLiNER recognizer (non-fatal): %s", exc)

    return _analyzer_engine


def _split_text_chunks(text: str, max_chars: int = CHUNK_MAX_CHARS) -> List[str]:
    """Split *text* into chunks of at most *max_chars* characters.

    Tries to break on newline boundaries so we don't split in the middle of a
    PII entity (e.g. a multi-word name).  Falls back to a hard split when no
    newline is found within the window.
    """
    chunks: List[str] = []
    start = 0
    length = len(text)

    while start < length:
        end = start + max_chars
        if end >= length:
            chunks.append(text[start:])
            break

        # Try to break at the last newline within the chunk
        newline_pos = text.rfind('\n', start, end)
        if newline_pos > start:
            chunks.append(text[start:newline_pos + 1])
            start = newline_pos + 1
        else:
            # No newline found; hard-split at max_chars
            chunks.append(text[start:end])
            start = end

    return chunks


def analyze_text(
    text: str,
    language: str = "en",
    score_threshold: float = 0.35,
    max_size: int = MAX_TEXT_SIZE_BYTES,
) -> PiiResult:
    """Analyze *text* for PII entities.

    For texts that exceed spaCy's ``nlp.max_length`` (1 M characters) the input
    is automatically split into smaller chunks, each chunk is analyzed
    independently, and the results are merged.  This avoids the ``E088``
    ``ValueError`` while still scanning the entire document.

    Args:
        text: The text content to scan.
        language: ISO-639-1 language code (default ``"en"``).
        score_threshold: Minimum confidence score to accept a detection.
        max_size: Truncate text to this many bytes before analysis.

    Returns:
        A :class:`PiiResult` with deduplicated entity type names and total count.
    """
    if not text or not text.strip():
        return PiiResult()

    # Truncate oversized text to avoid excessive memory / time
    if len(text.encode("utf-8", errors="replace")) > max_size:
        text = text[:max_size]
        logger.warning("Text truncated to %d bytes for PII analysis", max_size)

    try:
        analyzer = _get_analyzer()

        # Split into chunks if the text exceeds the spaCy character limit
        if len(text) > CHUNK_MAX_CHARS:
            chunks = _split_text_chunks(text, CHUNK_MAX_CHARS)
            logger.info(
                "Text of %d chars split into %d chunks for PII analysis",
                len(text), len(chunks),
            )
        else:
            chunks = [text]

        all_entities: List[str] = []
        for idx, chunk in enumerate(chunks):
            try:
                results = analyzer.analyze(
                    text=chunk,
                    language=language,
                    score_threshold=score_threshold,
                )
                all_entities.extend(r.entity_type for r in results)
            except Exception as chunk_exc:
                logger.warning(
                    "PII analysis failed on chunk %d/%d (%d chars): %s",
                    idx + 1, len(chunks), len(chunk), chunk_exc,
                )

        # Compute per-tier risk counts
        high = medium = low = 0
        for entity in all_entities:
            level = get_risk_level(entity)
            if level == "high":
                high += 1
            elif level == "medium":
                medium += 1
            else:
                low += 1

        return PiiResult(
            entities=all_entities,
            count=len(all_entities),
            risk_level=highest_risk_level(all_entities),
            high_risk_count=high,
            medium_risk_count=medium,
            low_risk_count=low,
        )
    except Exception as exc:
        logger.error("PII analysis failed: %s", exc, exc_info=True)
        return PiiResult()
