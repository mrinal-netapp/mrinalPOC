"""Unit tests for analyzers.sensitivity (CLIP-based image sensitivity classification)."""

import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import analyzers.sensitivity as sensitivity_module
from analyzers.sensitivity import (
    ALL_LABELS,
    PUBLIC_LABELS,
    SENSITIVE_LABELS,
    SensitivityResult,
    _get_classifier,
    classify_image,
)


class TestGetClassifier(unittest.TestCase):
    def setUp(self):
        sensitivity_module._classifier = None
        sensitivity_module._classifier_init_attempted = False

    def tearDown(self):
        sensitivity_module._classifier = None
        sensitivity_module._classifier_init_attempted = False

    def test_import_error_returns_none_and_caches_attempt(self):
        # Force the ImportError branch deterministically: transformers is a real
        # requirements.txt dependency, so it IS installed in CI (it was only
        # absent in some local/sandbox venvs) -- relying on that absence made
        # this test environment-dependent. Setting the sys.modules entry to None
        # makes `from transformers import pipeline` raise ImportError regardless
        # of whether the real package is installed.
        with patch.dict(sys.modules, {"transformers": None}):
            result = _get_classifier()
        self.assertIsNone(result)
        self.assertTrue(sensitivity_module._classifier_init_attempted)

    def test_does_not_retry_after_first_attempt(self):
        sensitivity_module._classifier_init_attempted = True
        sensitivity_module._classifier = None
        result = _get_classifier()
        self.assertIsNone(result)

    def test_generic_init_exception_returns_none(self):
        fake_transformers = types.ModuleType("transformers")
        fake_transformers.pipeline = MagicMock(side_effect=RuntimeError("no GPU"))
        with patch.dict(sys.modules, {"transformers": fake_transformers}):
            result = _get_classifier()
        self.assertIsNone(result)
        self.assertTrue(sensitivity_module._classifier_init_attempted)

    def test_successful_init_returns_and_caches_pipeline(self):
        fake_pipeline_instance = MagicMock()
        fake_transformers = types.ModuleType("transformers")
        fake_transformers.pipeline = MagicMock(return_value=fake_pipeline_instance)
        with patch.dict(sys.modules, {"transformers": fake_transformers}):
            result = _get_classifier()
        self.assertIs(result, fake_pipeline_instance)
        # Second call should hit the cache without calling pipeline() again.
        second = _get_classifier()
        self.assertIs(second, fake_pipeline_instance)
        fake_transformers.pipeline.assert_called_once()


class TestClassifyImage(unittest.TestCase):
    def setUp(self):
        sensitivity_module._classifier = None
        sensitivity_module._classifier_init_attempted = False

    def tearDown(self):
        sensitivity_module._classifier = None
        sensitivity_module._classifier_init_attempted = False

    def _patch_pil(self):
        fake_pil_module = types.ModuleType("PIL")
        fake_image_module = types.ModuleType("PIL.Image")
        fake_img = MagicMock()
        fake_img.convert = MagicMock(return_value=fake_img)
        fake_image_module.open = MagicMock(return_value=fake_img)
        fake_pil_module.Image = fake_image_module
        return fake_pil_module, fake_image_module

    def test_no_classifier_returns_unknown(self):
        with patch.object(sensitivity_module, "_get_classifier", return_value=None):
            result = classify_image("/tmp/photo.jpg")
        self.assertEqual(result, SensitivityResult(sensitivity_class="unknown"))

    def test_empty_predictions_returns_unknown(self):
        fake_classifier = MagicMock(return_value=[])
        fake_pil_module, fake_image_module = self._patch_pil()
        with patch.object(sensitivity_module, "_get_classifier", return_value=fake_classifier):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = classify_image("/tmp/photo.jpg")
        self.assertEqual(result.sensitivity_class, "unknown")

    def test_top_sensitive_label_above_threshold_returns_sensitive(self):
        fake_classifier = MagicMock(
            return_value=[{"label": SENSITIVE_LABELS[0], "score": 0.9}]
        )
        fake_pil_module, fake_image_module = self._patch_pil()
        with patch.object(sensitivity_module, "_get_classifier", return_value=fake_classifier):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = classify_image("/tmp/photo.jpg", threshold=0.35)
        self.assertEqual(result.sensitivity_class, "sensitive")
        self.assertEqual(result.top_label, SENSITIVE_LABELS[0])
        self.assertEqual(result.top_score, 0.9)

    def test_top_sensitive_label_below_threshold_returns_public(self):
        fake_classifier = MagicMock(
            return_value=[{"label": SENSITIVE_LABELS[0], "score": 0.1}]
        )
        fake_pil_module, fake_image_module = self._patch_pil()
        with patch.object(sensitivity_module, "_get_classifier", return_value=fake_classifier):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = classify_image("/tmp/photo.jpg", threshold=0.35)
        self.assertEqual(result.sensitivity_class, "public")

    def test_top_public_label_returns_public(self):
        fake_classifier = MagicMock(
            return_value=[{"label": PUBLIC_LABELS[0], "score": 0.95}]
        )
        fake_pil_module, fake_image_module = self._patch_pil()
        with patch.object(sensitivity_module, "_get_classifier", return_value=fake_classifier):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = classify_image("/tmp/photo.jpg")
        self.assertEqual(result.sensitivity_class, "public")
        self.assertEqual(result.top_label, PUBLIC_LABELS[0])

    def test_classification_exception_returns_unknown(self):
        fake_classifier = MagicMock(side_effect=RuntimeError("inference failed"))
        fake_pil_module, fake_image_module = self._patch_pil()
        with patch.object(sensitivity_module, "_get_classifier", return_value=fake_classifier):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = classify_image("/tmp/photo.jpg")
        self.assertEqual(result.sensitivity_class, "unknown")

    def test_image_open_exception_returns_unknown(self):
        fake_classifier = MagicMock()
        fake_pil_module = types.ModuleType("PIL")
        fake_image_module = types.ModuleType("PIL.Image")
        fake_image_module.open = MagicMock(side_effect=OSError("cannot identify image"))
        fake_pil_module.Image = fake_image_module
        with patch.object(sensitivity_module, "_get_classifier", return_value=fake_classifier):
            with patch.dict(sys.modules, {"PIL": fake_pil_module, "PIL.Image": fake_image_module}):
                result = classify_image("/tmp/corrupt.jpg")
        self.assertEqual(result.sensitivity_class, "unknown")

    def test_all_labels_is_union_of_sensitive_and_public(self):
        self.assertEqual(ALL_LABELS, SENSITIVE_LABELS + PUBLIC_LABELS)


if __name__ == "__main__":
    unittest.main()
