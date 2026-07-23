"""Tests for Config.from_dict() and Config.from_environment() from processing.config."""

import os
import unittest
from unittest.mock import MagicMock, patch

from processing.config import Config


class TestConfigFromDict(unittest.TestCase):

    def test_empty_dict_uses_defaults(self):
        cfg = Config.from_dict({})
        self.assertEqual(cfg.dataset_id, "")
        self.assertEqual(cfg.dataset_kind, "structured")
        self.assertEqual(cfg.lakekeeper_url, "http://lakekeeper:8181")
        self.assertFalse(cfg.enable_pii_analysis)

    def test_from_dict_sets_string_fields(self):
        data = {
            "dataset_id": "ds-1",
            "dataset_name": "My Dataset",
            "project_id": "p1",
            "bucket_name": "b1",
            "manifest_s3_key": "s3://b1/manifest.json",
            "output_prefix": "out/",
            "set_id": "set-0",
            "project_client_id": "cid",
            "project_client_secret": "secret",
            "aws_access_key_id": "ak",
            "aws_secret_access_key": "sk",
            "s3_endpoint": "http://s3:7070",
        }
        cfg = Config.from_dict(data)
        self.assertEqual(cfg.dataset_id, "ds-1")
        self.assertEqual(cfg.dataset_name, "My Dataset")
        self.assertEqual(cfg.project_id, "p1")
        self.assertEqual(cfg.bucket_name, "b1")
        self.assertEqual(cfg.manifest_s3_key, "s3://b1/manifest.json")
        self.assertEqual(cfg.output_prefix, "out/")
        self.assertEqual(cfg.set_id, "set-0")
        self.assertEqual(cfg.project_client_id, "cid")
        self.assertEqual(cfg.project_client_secret, "secret")
        self.assertEqual(cfg.aws_access_key_id, "ak")
        self.assertEqual(cfg.aws_secret_access_key, "sk")
        self.assertEqual(cfg.s3_endpoint, "http://s3:7070")

    def test_from_dict_bool_coercion(self):
        cfg_true = Config.from_dict({"enable_pii_analysis": "true"})
        self.assertTrue(cfg_true.enable_pii_analysis)

        cfg_one = Config.from_dict({"enable_pii_analysis": "1"})
        self.assertTrue(cfg_one.enable_pii_analysis)

        cfg_false = Config.from_dict({"enable_pii_analysis": "false"})
        self.assertFalse(cfg_false.enable_pii_analysis)

        cfg_bool = Config.from_dict({"enable_pii_analysis": True})
        self.assertTrue(cfg_bool.enable_pii_analysis)

    def test_from_dict_bool_coercion_non_str_non_bool(self):
        # Exercises the `return bool(val)` fallback for values that are
        # neither `bool` nor `str` (e.g. an int coming from loosely-typed JSON).
        cfg_truthy = Config.from_dict({"enable_pii_analysis": 1})
        self.assertTrue(cfg_truthy.enable_pii_analysis)

        cfg_falsy = Config.from_dict({"enable_pii_analysis": 0})
        self.assertFalse(cfg_falsy.enable_pii_analysis)

    def test_from_dict_ignores_unknown_keys(self):
        data = {
            "dataset_id": "ds-1",
            "unknown_field": "ignored",
            "another_unknown": 42,
        }
        cfg = Config.from_dict(data)
        self.assertEqual(cfg.dataset_id, "ds-1")
        self.assertFalse(hasattr(cfg, "unknown_field"))

    def test_validate_raises_on_missing_required(self):
        cfg = Config.from_dict({"dataset_id": "ds-1"})
        with self.assertRaises(ValueError) as ctx:
            cfg.validate()
        self.assertIn("Missing required config fields", str(ctx.exception))
        self.assertIn("bucket_name", str(ctx.exception))

    def test_validate_passes_when_required_set(self):
        cfg = Config.from_dict({
            "dataset_id": "ds-1",
            "dataset_name": "DS",
            "project_id": "p1",
            "bucket_name": "b1",
            "project_client_id": "c",
            "project_client_secret": "s",
            "aws_access_key_id": "ak",
            "aws_secret_access_key": "sk",
            "s3_endpoint": "http://s3",
        })
        cfg.validate()


class TestConfigFromEnvironment(unittest.TestCase):

    def test_from_environment_defaults(self):
        # Clear relevant env so we get defaults
        env_vars = [
            "DATASET_ID", "DATASET_NAME", "PROJECT_ID", "BUCKET_NAME",
            "LAKEKEEPER_URL", "CONFIG_SERVICE_URL",
        ]
        saved = {k: os.environ.pop(k, None) for k in env_vars}
        try:
            cfg = Config.from_environment()
            self.assertEqual(cfg.dataset_kind, "structured")
            self.assertEqual(cfg.namespace, "default")
            self.assertEqual(cfg.lakekeeper_url, "http://lakekeeper:8181")
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_from_environment_reads_vars(self):
        os.environ["DATASET_ID"] = "env-ds"
        os.environ["BUCKET_NAME"] = "env-bucket"
        try:
            cfg = Config.from_environment()
            self.assertEqual(cfg.dataset_id, "env-ds")
            self.assertEqual(cfg.bucket_name, "env-bucket")
        finally:
            os.environ.pop("DATASET_ID", None)
            os.environ.pop("BUCKET_NAME", None)


class TestEffectiveWarehouseId(unittest.TestCase):
    def _clear_env(self):
        saved = {
            k: os.environ.pop(k, None) for k in ("WAREHOUSE_NAME", "DEPLOYMENT_NAME")
        }
        return saved

    def _restore_env(self, saved):
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v

    def test_uses_configured_warehouse_id_first(self):
        cfg = Config.from_dict({"warehouse_id": "wh-1"})
        self.assertEqual(cfg.effective_warehouse_id(), "wh-1")

    def test_falls_back_to_warehouse_name_env(self):
        saved = self._clear_env()
        try:
            os.environ["WAREHOUSE_NAME"] = "env-wh"
            cfg = Config.from_dict({})
            self.assertEqual(cfg.effective_warehouse_id(), "env-wh")
        finally:
            os.environ.pop("WAREHOUSE_NAME", None)
            self._restore_env(saved)

    def test_falls_back_to_deployment_name_env(self):
        saved = self._clear_env()
        try:
            os.environ["DEPLOYMENT_NAME"] = "deploy-wh"
            cfg = Config.from_dict({})
            self.assertEqual(cfg.effective_warehouse_id(), "deploy-wh")
        finally:
            os.environ.pop("DEPLOYMENT_NAME", None)
            self._restore_env(saved)

    def test_raises_when_nothing_configured(self):
        saved = self._clear_env()
        try:
            cfg = Config.from_dict({})
            with self.assertRaises(ValueError):
                cfg.effective_warehouse_id()
        finally:
            self._restore_env(saved)


class TestOAuthHelpers(unittest.TestCase):
    def test_get_access_token_raises_when_issuer_missing(self):
        cfg = Config.from_dict({"keycloak_internal_issuer": ""})
        with self.assertRaises(ValueError):
            cfg.get_access_token()

    def test_get_access_token_posts_and_returns_token(self):
        cfg = Config.from_dict({
            "keycloak_internal_issuer": "http://keycloak/realms/nemo",
            "project_client_id": "cid",
            "project_client_secret": "secret",
        })
        fake_response = MagicMock()
        fake_response.json.return_value = {"access_token": "abc123"}
        fake_response.raise_for_status = MagicMock()

        with patch("requests.post", return_value=fake_response) as mock_post:
            token = cfg.get_access_token()

        self.assertEqual(token, "abc123")
        called_url = mock_post.call_args[0][0]
        self.assertEqual(called_url, "http://keycloak/realms/nemo/protocol/openid-connect/token")
        called_data = mock_post.call_args.kwargs["data"]
        self.assertEqual(called_data["client_id"], "cid")
        self.assertEqual(called_data["client_secret"], "secret")

    def test_get_authenticated_session_sets_bearer_header(self):
        cfg = Config.from_dict({"keycloak_internal_issuer": "http://keycloak"})
        with patch.object(cfg, "get_access_token", return_value="tok-xyz"):
            session = cfg.get_authenticated_session()
        self.assertEqual(session.headers["Authorization"], "Bearer tok-xyz")
        self.assertEqual(session.headers["Content-Type"], "application/json")


class TestStoreRootAndKeys(unittest.TestCase):
    def test_default_store_root_unset_returns_none(self):
        saved = os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
        try:
            self.assertIsNone(Config.default_store_root())
        finally:
            if saved is not None:
                os.environ["NEMO_DEFAULT_STORE_ROOT"] = saved

    def test_default_store_root_returns_configured_value(self):
        saved = os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
        try:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = "/mnt/test"
            self.assertEqual(Config.default_store_root(), "/mnt/test")
        finally:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
            if saved is not None:
                os.environ["NEMO_DEFAULT_STORE_ROOT"] = saved

    def test_use_posix_reflects_store_root_presence(self):
        saved = os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
        try:
            cfg = Config.from_dict({})
            self.assertFalse(cfg.use_posix())
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = "/mnt/test"
            self.assertTrue(cfg.use_posix())
        finally:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
            if saved is not None:
                os.environ["NEMO_DEFAULT_STORE_ROOT"] = saved

    def test_progress_key_with_override(self):
        cfg = Config.from_dict({"dataset_id": "ds-1"})
        self.assertEqual(cfg.progress_key(override="custom/progress.json"), "custom/progress.json")

    def test_progress_key_with_s3_prefix(self):
        cfg = Config.from_dict({"dataset_id": "ds-1", "s3_path_prefix": "tenant/proj"})
        self.assertEqual(
            cfg.progress_key(), "tenant/proj/datasets/ds-1/progress.json"
        )

    def test_progress_key_without_s3_prefix(self):
        cfg = Config.from_dict({"dataset_id": "ds-1"})
        self.assertEqual(cfg.progress_key(), "datasets/ds-1/progress.json")

    def test_result_key_with_s3_prefix(self):
        cfg = Config.from_dict({"dataset_id": "ds-1", "s3_path_prefix": "tenant/proj"})
        self.assertEqual(
            cfg.result_key(), "tenant/proj/datasets/ds-1/processing_result.json"
        )

    def test_result_key_without_s3_prefix(self):
        cfg = Config.from_dict({"dataset_id": "ds-1"})
        self.assertEqual(cfg.result_key(), "datasets/ds-1/processing_result.json")

    def test_posix_path_uses_configured_store_root(self):
        saved = os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
        try:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = "/mnt/custom"
            cfg = Config.from_dict({})
            self.assertEqual(str(cfg.posix_path("a/b.json")), "/mnt/custom/a/b.json")
        finally:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
            if saved is not None:
                os.environ["NEMO_DEFAULT_STORE_ROOT"] = saved

    def test_posix_path_falls_back_to_default_mount(self):
        saved = os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)
        try:
            cfg = Config.from_dict({})
            self.assertEqual(str(cfg.posix_path("a/b.json")), "/mnt/pvcs/default-nemo/a/b.json")
        finally:
            if saved is not None:
                os.environ["NEMO_DEFAULT_STORE_ROOT"] = saved


if __name__ == "__main__":
    unittest.main()
