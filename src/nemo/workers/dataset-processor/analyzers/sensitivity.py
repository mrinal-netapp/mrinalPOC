"""
Image sensitivity classification.

Classifies images as ``sensitive``, ``public``, or ``unknown`` using a
lightweight CLIP-based zero-shot classifier.  The default implementation
uses the ``openai/clip-vit-base-patch32`` model from HuggingFace
transformers with a small set of candidate labels.

If the model is not available (e.g. dependencies not installed or no GPU),
the classifier gracefully falls back to ``"unknown"``.

Usage:
    from analyzers.sensitivity import classify_image
    result = classify_image("/tmp/photo.jpg")
    # result.sensitivity_class in ("sensitive", "public", "unknown")
"""

from observability_client_runtime import get_logger
from dataclasses import dataclass
from pathlib import Path
from typing import Union

logger = get_logger()

# Lazy-loaded classifier pipeline
_classifier = None
_classifier_init_attempted = False

# Labels used for zero-shot image classification
SENSITIVE_LABELS = [
    "sensitive personal information",
    "medical record",
    "identity document",
    "financial document",
    "nudity or explicit content",
]
PUBLIC_LABELS = [
    "landscape or scenery",
    "public building or architecture",
    "generic object or product",
    "diagram or chart",
    "text document without personal information",
]
ALL_LABELS = SENSITIVE_LABELS + PUBLIC_LABELS

# Threshold: if the top sensitive label score exceeds this, classify as sensitive
SENSITIVITY_THRESHOLD = 0.35


@dataclass
class SensitivityResult:
    """Result of image sensitivity classification."""
    sensitivity_class: str  # "sensitive", "public", "unknown", or "not_applicable"
    top_label: str = ""
    top_score: float = 0.0


def _get_classifier():
    """Lazily initialize the zero-shot image classification pipeline."""
    global _classifier, _classifier_init_attempted

    if _classifier_init_attempted:
        return _classifier

    _classifier_init_attempted = True

    try:
        from transformers import pipeline

        _classifier = pipeline(
            "zero-shot-image-classification",
            model="openai/clip-vit-base-patch32",
        )
        logger.info("CLIP zero-shot image classifier loaded successfully")
    except ImportError:
        logger.warning(
            "transformers library not available; image sensitivity classification disabled"
        )
    except Exception as exc:
        logger.warning(
            "Failed to load CLIP classifier (non-fatal): %s", exc
        )

    return _classifier


def classify_image(
    image_path: Union[str, Path],
    threshold: float = SENSITIVITY_THRESHOLD,
) -> SensitivityResult:
    """Classify an image as sensitive, public, or unknown.

    Args:
        image_path: Path to the image file.
        threshold: Score above which a sensitive label triggers ``"sensitive"``.

    Returns:
        A :class:`SensitivityResult` with the classification.
    """
    classifier = _get_classifier()
    if classifier is None:
        return SensitivityResult(sensitivity_class="unknown")

    try:
        from PIL import Image

        img = Image.open(str(image_path)).convert("RGB")
        predictions = classifier(img, candidate_labels=ALL_LABELS)

        if not predictions:
            return SensitivityResult(sensitivity_class="unknown")

        top = predictions[0]
        top_label = top["label"]
        top_score = top["score"]

        if top_label in SENSITIVE_LABELS and top_score >= threshold:
            return SensitivityResult(
                sensitivity_class="sensitive",
                top_label=top_label,
                top_score=top_score,
            )
        else:
            return SensitivityResult(
                sensitivity_class="public",
                top_label=top_label,
                top_score=top_score,
            )

    except Exception as exc:
        logger.warning(
            "Image sensitivity classification failed for %s: %s",
            image_path,
            exc,
        )
        return SensitivityResult(sensitivity_class="unknown")
