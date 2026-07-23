"""Unit tests for analyzers._gliner_recognizer (optional GLiNER-backed Presidio recognizer)."""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch


def _install_fake_gliner_package(model_instance=None, from_pretrained_side_effect=None):
    fake_gliner_module = types.ModuleType("gliner")

    class FakeGLiNER:
        @staticmethod
        def from_pretrained(model_name):
            if from_pretrained_side_effect is not None:
                raise from_pretrained_side_effect
            return model_instance if model_instance is not None else MagicMock()

    fake_gliner_module.GLiNER = FakeGLiNER
    return fake_gliner_module


def _install_fake_presidio_analyzer():
    fake_module = types.ModuleType("presidio_analyzer")

    class FakeRecognizerResult:
        def __init__(self, entity_type, start, end, score, analysis_explanation=None,
                     recognition_metadata=None):
            self.entity_type = entity_type
            self.start = start
            self.end = end
            self.score = score
            self.recognition_metadata = recognition_metadata

    fake_module.RecognizerResult = FakeRecognizerResult
    return fake_module


class TestGlinerRecognizerInit(unittest.TestCase):
    def test_raises_import_error_when_gliner_not_installed(self):
        from analyzers._gliner_recognizer import GlinerRecognizer

        # Force the ImportError branch deterministically: `gliner` isn't in
        # requirements.txt today, but relying on its ambient absence would
        # make this test brittle against future CI/image changes (the same
        # class of issue fixed for presidio-image-redactor/transformers
        # elsewhere in this test suite).
        with patch.dict(sys.modules, {"gliner": None}):
            with self.assertRaises(ImportError):
                GlinerRecognizer()

    def test_loads_model_and_sets_attributes(self):
        from analyzers._gliner_recognizer import GLINER_TO_PRESIDIO, GlinerRecognizer

        fake_model = MagicMock()
        fake_gliner_module = _install_fake_gliner_package(model_instance=fake_model)

        with patch.dict(sys.modules, {"gliner": fake_gliner_module}):
            recognizer = GlinerRecognizer()

        self.assertIs(recognizer.model, fake_model)
        self.assertEqual(recognizer.name, "GLiNER")
        self.assertEqual(recognizer.supported_language, "en")
        self.assertEqual(
            set(recognizer.supported_entities), set(GLINER_TO_PRESIDIO.values())
        )

    def test_uses_custom_model_name(self):
        from analyzers._gliner_recognizer import GlinerRecognizer

        captured = {}

        fake_gliner_module = types.ModuleType("gliner")

        class FakeGLiNER:
            @staticmethod
            def from_pretrained(model_name):
                captured["model_name"] = model_name
                return MagicMock()

        fake_gliner_module.GLiNER = FakeGLiNER

        with patch.dict(sys.modules, {"gliner": fake_gliner_module}):
            GlinerRecognizer(model_name="custom/model")

        self.assertEqual(captured["model_name"], "custom/model")


class TestGlinerRecognizerInterface(unittest.TestCase):
    def _make_recognizer(self, fake_model=None):
        from analyzers._gliner_recognizer import GlinerRecognizer

        fake_gliner_module = _install_fake_gliner_package(
            model_instance=fake_model if fake_model is not None else MagicMock()
        )
        with patch.dict(sys.modules, {"gliner": fake_gliner_module}):
            return GlinerRecognizer()

    def test_id_property(self):
        recognizer = self._make_recognizer()
        self.assertEqual(recognizer.id, "gliner_recognizer")

    def test_load_is_a_noop(self):
        recognizer = self._make_recognizer()
        self.assertIsNone(recognizer.load())

    def test_analyze_prediction_failure_returns_empty_list(self):
        fake_model = MagicMock()
        fake_model.predict_entities = MagicMock(side_effect=RuntimeError("inference failed"))
        recognizer = self._make_recognizer(fake_model=fake_model)

        fake_presidio_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_presidio_module}):
            results = recognizer.analyze("John lives in NYC")

        self.assertEqual(results, [])

    def test_analyze_maps_known_labels_to_presidio_types(self):
        fake_model = MagicMock()
        fake_model.predict_entities = MagicMock(return_value=[
            {"label": "person", "start": 0, "end": 4, "score": 0.8},
            {"label": "email", "start": 10, "end": 25, "score": 0.7},
        ])
        recognizer = self._make_recognizer(fake_model=fake_model)

        fake_presidio_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_presidio_module}):
            results = recognizer.analyze("John's email is john@example.com")

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].entity_type, "PERSON")
        self.assertEqual(results[1].entity_type, "EMAIL_ADDRESS")
        self.assertEqual(results[0].recognition_metadata, {"recognizer_name": "gliner_recognizer"})

    def test_analyze_skips_unmapped_labels(self):
        fake_model = MagicMock()
        fake_model.predict_entities = MagicMock(return_value=[
            {"label": "some_unmapped_label", "start": 0, "end": 4, "score": 0.8},
        ])
        recognizer = self._make_recognizer(fake_model=fake_model)

        fake_presidio_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_presidio_module}):
            results = recognizer.analyze("some text")

        self.assertEqual(results, [])

    def test_analyze_filters_by_requested_entities(self):
        fake_model = MagicMock()
        fake_model.predict_entities = MagicMock(return_value=[
            {"label": "person", "start": 0, "end": 4, "score": 0.8},
            {"label": "email", "start": 10, "end": 25, "score": 0.7},
        ])
        recognizer = self._make_recognizer(fake_model=fake_model)

        fake_presidio_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_presidio_module}):
            results = recognizer.analyze(
                "John's email is john@example.com", entities=["EMAIL_ADDRESS"]
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].entity_type, "EMAIL_ADDRESS")

    def test_analyze_defaults_score_when_missing(self):
        fake_model = MagicMock()
        fake_model.predict_entities = MagicMock(return_value=[
            {"label": "person", "start": 0, "end": 4},
        ])
        recognizer = self._make_recognizer(fake_model=fake_model)

        fake_presidio_module = _install_fake_presidio_analyzer()
        with patch.dict(sys.modules, {"presidio_analyzer": fake_presidio_module}):
            results = recognizer.analyze("John")

        self.assertEqual(results[0].score, 0.5)


if __name__ == "__main__":
    unittest.main()
