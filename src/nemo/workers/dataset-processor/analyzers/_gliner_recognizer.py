"""
Optional GLiNER-based recognizer for Presidio.

Provides improved NER recall for names, addresses, and other free-text PII
by using a GLiNER zero-shot NER model as an additional Presidio recognizer.

This module is **optional**.  If `gliner` is not installed the import will
fail silently and the Presidio AnalyzerEngine will use its built-in
recognizers only.

References:
    - https://github.com/urchade/GLiNER
    - https://microsoft.github.io/presidio/samples/python/gliner/
"""

from observability_client_runtime import get_logger
from typing import List, Optional

logger = get_logger()

# GLiNER model to use – the multi-PII variant supports 55+ entity types
DEFAULT_MODEL = "urchade/gliner_multi_pii-v1"

# Mapping from GLiNER entity labels to Presidio entity types
GLINER_TO_PRESIDIO = {
    "person": "PERSON",
    "phone number": "PHONE_NUMBER",
    "email": "EMAIL_ADDRESS",
    "credit card number": "CREDIT_CARD",
    "social security number": "US_SSN",
    "address": "LOCATION",
    "passport number": "US_PASSPORT",
    "driver license": "US_DRIVER_LICENSE",
    "date of birth": "DATE_TIME",
    "ip address": "IP_ADDRESS",
    "organization": "ORGANIZATION",
    "location": "LOCATION",
    "url": "URL",
    "iban": "IBAN_CODE",
}


class GlinerRecognizer:
    """Presidio-compatible recognizer backed by GLiNER."""

    def __init__(self, model_name: str = DEFAULT_MODEL):
        from gliner import GLiNER  # will raise ImportError if not installed

        self.model = GLiNER.from_pretrained(model_name)
        self.name = "GLiNER"
        self.supported_language = "en"
        self.supported_entities = list(set(GLINER_TO_PRESIDIO.values()))
        logger.info("GLiNER model loaded: %s", model_name)

    # Presidio recognizer interface
    @property
    def id(self) -> str:
        return "gliner_recognizer"

    def load(self) -> None:
        pass  # already loaded in __init__

    def analyze(
        self,
        text: str,
        entities: Optional[List[str]] = None,
        nlp_artifacts=None,
        regex_flags: int = 0,
    ) -> list:
        """Run GLiNER NER and return Presidio RecognizerResult objects."""
        from presidio_analyzer import RecognizerResult

        # Ask GLiNER for the entity labels we know how to map
        gliner_labels = list(GLINER_TO_PRESIDIO.keys())

        try:
            predictions = self.model.predict_entities(
                text, gliner_labels, threshold=0.3
            )
        except Exception as exc:
            logger.warning("GLiNER prediction failed: %s", exc)
            return []

        results: List[RecognizerResult] = []
        for pred in predictions:
            presidio_type = GLINER_TO_PRESIDIO.get(pred["label"])
            if presidio_type is None:
                continue
            # Skip if caller asked for specific entities and this one isn't in the list
            if entities and presidio_type not in entities:
                continue
            results.append(
                RecognizerResult(
                    entity_type=presidio_type,
                    start=pred["start"],
                    end=pred["end"],
                    score=pred.get("score", 0.5),
                    analysis_explanation=None,
                    recognition_metadata={
                        "recognizer_name": self.id,
                    },
                )
            )

        return results
