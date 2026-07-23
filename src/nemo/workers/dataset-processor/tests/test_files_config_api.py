"""Unit tests for config-service API helpers in processing.files:

- `get_dataset` (success, HTTP failure, exception)
- `update_dataset_status`, `update_dataset_catalog_ref`, `update_dataset_pii_summary`, `update_facet`
- `write_processing_result`
- `write_pii_details` (risk-tier aggregation, entity JSON parsing, legacy tables without
  a pii_risk_level column, sensitivity_class presence, s3_path_prefix key construction)
"""

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

import pyarrow as pa

from processing.config import Config
from processing.files import (
    _read_json,
    get_dataset,
    update_dataset_catalog_ref,
    update_dataset_pii_summary,
    update_dataset_status,
    update_facet,
    write_pii_details,
    write_processing_result,
)


def _minimal_config(**overrides) -> Config:
    base = {
        "dataset_id": "ds-test",
        "dataset_name": "test-ds",
        "project_id": "proj-1",
        "bucket_name": "bucket",
        "project_client_id": "cid",
        "project_client_secret": "secret",
        "aws_access_key_id": "ak",
        "aws_secret_access_key": "sk",
        "s3_endpoint": "http://s3:7070",
    }
    base.update(overrides)
    return Config.from_dict(base)


class _MountFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved_root = os.environ.get("NEMO_DEFAULT_STORE_ROOT")
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.config = _minimal_config()

    def tearDown(self):
        if self._saved_root is not None:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._saved_root
        else:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)


class TestGetDataset(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.get")
    def test_http_error_returns_none(self, mock_get, _tok):
        resp = mock.Mock()
        resp.raise_for_status.side_effect = Exception("HTTP 500")
        mock_get.return_value = resp
        self.assertIsNone(get_dataset(self.config))

    @mock.patch.object(Config, "get_access_token", side_effect=Exception("auth failed"))
    def test_token_failure_returns_none(self, _tok):
        self.assertIsNone(get_dataset(self.config))


class TestUpdateDatasetStatus(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_sends_status_payload(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_dataset_status(self.config, "completed")
        _, kwargs = mock_put.call_args
        self.assertEqual(kwargs["json"], {"status": "completed"})

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_includes_error_message_when_provided(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_dataset_status(self.config, "failed", error_message="boom")
        _, kwargs = mock_put.call_args
        self.assertEqual(kwargs["json"], {"status": "failed", "errorMessage": "boom"})

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_raises_on_http_error(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.side_effect = Exception("HTTP 500")
        mock_put.return_value = resp
        with self.assertRaises(Exception):
            update_dataset_status(self.config, "failed")


class TestUpdateDatasetCatalogRef(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_splits_namespace_and_table_name(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_dataset_catalog_ref(self.config, "myns.mytable")
        _, kwargs = mock_put.call_args
        self.assertEqual(kwargs["json"]["namespace"], "myns")
        self.assertEqual(kwargs["json"]["catalogTableName"], "mytable")

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_defaults_namespace_when_no_dot(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_dataset_catalog_ref(self.config, "justtable")
        _, kwargs = mock_put.call_args
        self.assertEqual(kwargs["json"]["namespace"], "default")
        self.assertEqual(kwargs["json"]["catalogTableName"], "justtable")

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_exception_is_swallowed(self, mock_put, _tok):
        mock_put.side_effect = Exception("network down")
        update_dataset_catalog_ref(self.config, "ns.table")  # must not raise


class TestUpdateDatasetPiiSummary(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_sends_pii_summary_payload(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_dataset_pii_summary(self.config, {"filesWithPii": 3})
        _, kwargs = mock_put.call_args
        self.assertEqual(kwargs["json"], {"piiSummary": {"filesWithPii": 3}})

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_exception_is_swallowed(self, mock_put, _tok):
        mock_put.side_effect = Exception("network down")
        update_dataset_pii_summary(self.config, {"x": 1})  # must not raise


class TestUpdateFacet(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_minimal_payload_state_only(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_facet(self.config, "pii", "completed")
        url, kwargs = mock_put.call_args
        self.assertIn("/facets/pii", url[0])
        self.assertEqual(kwargs["json"], {"state": "completed"})

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_full_payload_with_summary_error_and_job_id(self, mock_put, _tok):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        mock_put.return_value = resp
        update_facet(
            self.config, "pii", "failed",
            summary={"count": 1}, error_message="boom", job_id="job-1",
        )
        _, kwargs = mock_put.call_args
        self.assertEqual(kwargs["json"], {
            "state": "failed", "summary": {"count": 1},
            "errorMessage": "boom", "jobId": "job-1",
        })

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.put")
    def test_exception_is_swallowed(self, mock_put, _tok):
        mock_put.side_effect = Exception("network down")
        update_facet(self.config, "pii", "failed")  # must not raise


class TestWriteProcessingResult(_MountFixture):
    def test_writes_json_result_to_result_key(self):
        write_processing_result(self.config, {"status": "ok", "rows": 5})
        data = _read_json(self.config, self.config.result_key())
        self.assertEqual(data, {"status": "ok", "rows": 5})


class TestWritePiiDetails(_MountFixture):
    def _table(self, **cols):
        return pa.table(cols)

    def test_basic_summary_counts_with_risk_level_column(self):
        table = self._table(
            file_name=["a.txt", "b.png"],
            file_path=["file:///a.txt", "file:///b.png"],
            file_size=[10, 20],
            mime_type=["text/plain", "image/png"],
            pii_entities=[json.dumps(["EMAIL_ADDRESS"]), None],
            pii_count=[1, 0],
            has_pii=[True, False],
            pii_risk_level=["medium", "none"],
            sensitivity_class=["not_applicable", "public"],
        )
        write_pii_details(self.config, table)
        key = f"datasets/{self.config.dataset_id}/pii_details.json"
        details = _read_json(self.config, key)
        self.assertEqual(details["summary"]["totalFiles"], 2)
        self.assertEqual(details["summary"]["filesWithPii"], 1)
        self.assertEqual(details["summary"]["filesWithMediumRisk"], 1)
        self.assertEqual(details["files"][0]["entities"], ["EMAIL_ADDRESS"])
        self.assertEqual(details["files"][1]["sensitivityClass"], "public")

    def test_uses_s3_path_prefix_in_key_when_configured(self):
        cfg = _minimal_config(s3_path_prefix="prefix1")
        table = self._table(
            file_name=["a.txt"], file_path=["file:///a.txt"], file_size=[10],
            mime_type=["text/plain"], pii_entities=[None], pii_count=[0],
            has_pii=[False], pii_risk_level=["none"],
        )
        write_pii_details(cfg, table)
        key = f"prefix1/datasets/{cfg.dataset_id}/pii_details.json"
        details = _read_json(cfg, key)
        self.assertEqual(details["summary"]["totalFiles"], 1)

    def test_legacy_table_without_risk_level_column_defaults_to_medium(self):
        # No pii_risk_level column: falls back to get_risk_level(pii_count),
        # which isn't a valid entity type and so defaults to "medium".
        table = self._table(
            file_name=["a.txt"], file_path=["file:///a.txt"], file_size=[10],
            mime_type=["text/plain"], pii_entities=[None], pii_count=[3],
            has_pii=[True],
        )
        write_pii_details(self.config, table)
        key = f"datasets/{self.config.dataset_id}/pii_details.json"
        details = _read_json(self.config, key)
        self.assertEqual(details["files"][0]["riskLevel"], "medium")
        self.assertEqual(details["summary"]["filesWithMediumRisk"], 1)

    def test_invalid_json_entities_string_becomes_none(self):
        table = self._table(
            file_name=["a.txt"], file_path=["file:///a.txt"], file_size=[10],
            mime_type=["text/plain"], pii_entities=["not valid json"], pii_count=[1],
            has_pii=[True], pii_risk_level=["low"],
        )
        write_pii_details(self.config, table)
        key = f"datasets/{self.config.dataset_id}/pii_details.json"
        details = _read_json(self.config, key)
        self.assertEqual(details["files"][0]["entities"], [])
        self.assertEqual(details["summary"]["filesWithLowRisk"], 1)

    def test_high_risk_files_counted(self):
        table = self._table(
            file_name=["a.txt"], file_path=["file:///a.txt"], file_size=[10],
            mime_type=["text/plain"], pii_entities=[json.dumps(["US_SSN"])], pii_count=[1],
            has_pii=[True], pii_risk_level=["high"],
        )
        write_pii_details(self.config, table)
        key = f"datasets/{self.config.dataset_id}/pii_details.json"
        details = _read_json(self.config, key)
        self.assertEqual(details["summary"]["filesWithHighRisk"], 1)
        self.assertEqual(details["files"][0]["highRiskCount"], 1)

    def test_null_row_values_default_gracefully(self):
        table = pa.table({
            "file_name": pa.array([None], type=pa.string()),
            "file_path": pa.array([None], type=pa.string()),
            "file_size": pa.array([None], type=pa.int64()),
            "mime_type": pa.array([None], type=pa.string()),
            "pii_entities": pa.array([None], type=pa.string()),
            "pii_count": pa.array([None], type=pa.int64()),
            "has_pii": pa.array([None], type=pa.bool_()),
            "pii_risk_level": pa.array([None], type=pa.string()),
        })
        write_pii_details(self.config, table)
        key = f"datasets/{self.config.dataset_id}/pii_details.json"
        details = _read_json(self.config, key)
        self.assertEqual(details["files"][0]["fileName"], "")
        self.assertEqual(details["files"][0]["fileSize"], 0)
        self.assertEqual(details["files"][0]["piiCount"], 0)
        self.assertFalse(details["files"][0]["hasPii"])


if __name__ == "__main__":
    unittest.main()
