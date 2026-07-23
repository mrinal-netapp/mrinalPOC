"""Unit tests for RedashClient."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import requests

from activities.redash_client import RedashAPIError, RedashAuthError, RedashClient


def _mock_response(status_code=200, json_body=None, content=b"{}"):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.json.return_value = json_body if json_body is not None else {}
    resp.raise_for_status = MagicMock()
    if status_code >= 400 and status_code not in (404, 429):
        resp.raise_for_status.side_effect = requests.HTTPError(f"HTTP {status_code}")
    return resp


class TestRedashClientInit:
    def test_disables_tls_when_configured(self):
        client = RedashClient("https://redash.example.com", "api-key", verify_tls=False)
        assert client._session.verify is False

    @patch("activities.redash_client.os.path.isfile", return_value=True)
    def test_uses_custom_ca_bundle(self, _mock_isfile, monkeypatch):
        monkeypatch.setenv("REQUESTS_CA_BUNDLE", "/etc/ssl/custom.pem")
        client = RedashClient("https://redash.example.com", "api-key")
        assert client._session.verify == "/etc/ssl/custom.pem"


class TestRedashClientRequest:
    def test_auth_error_on_401(self):
        client = RedashClient("https://redash.example.com", "bad-key")
        client._session.request = MagicMock(return_value=_mock_response(401))
        with pytest.raises(RedashAuthError):
            client.test_connection()

    @patch("activities.redash_client.time.sleep")
    def test_retries_on_500(self, mock_sleep):
        client = RedashClient("https://redash.example.com", "api-key")
        client._session.request = MagicMock(
            side_effect=[
                _mock_response(500),
                _mock_response(500),
                _mock_response(500),
            ],
        )
        with pytest.raises(RedashAPIError):
            client.test_connection()
        assert client._session.request.call_count == 3
        assert mock_sleep.call_count == 3

    def test_ssl_error_not_retried(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._session.request = MagicMock(
            side_effect=requests.exceptions.SSLError("cert verify failed"),
        )
        with pytest.raises(RedashAPIError):
            client.test_connection()
        assert client._session.request.call_count == 1


class TestRedashClientApi:
    def test_list_queries_paginates(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"results": [{"id": i} for i in range(250)]}),
                _mock_response(200, {"results": [{"id": 250}]}),
            ],
        )
        out = client.list_queries()
        assert len(out) == 251
        assert client._request.call_count == 2

    def test_get_query_404_returns_none(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(404))
        assert client.get_query(99) is None

    def test_get_query_result_caps_rows(self):
        client = RedashClient(
            "https://redash.example.com", "api-key", max_result_rows=2
        )
        client._request = MagicMock(
            return_value=_mock_response(
                200,
                {"query_result": {"data": {"rows": [{"a": 1}, {"a": 2}, {"a": 3}]}}},
            ),
        )
        assert client.get_query_result(1) is None

    def test_execute_query_inline_result(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            return_value=_mock_response(
                200,
                {
                    "query_result": {
                        "data": {"rows": [{"x": 1}], "columns": [{"name": "x"}]}
                    }
                },
            ),
        )
        out = client.execute_query(7)
        assert out["data"]["rows"] == [{"x": 1}]

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_execute_query_polls_job(self, mock_mono, _mock_sleep):
        mock_mono.side_effect = [0.0, 0.0, 0.0, 10.0]
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"job": {"id": "job-1"}}),
                _mock_response(200, {"job": {"status": 3, "query_result_id": 55}}),
                _mock_response(
                    200,
                    {
                        "query_result": {
                            "data": {"rows": [{"y": 2}], "columns": [{"name": "y"}]}
                        }
                    },
                ),
            ],
        )
        out = client.execute_query(7, poll_interval=0.01)
        assert out["data"]["rows"] == [{"y": 2}]

    def test_list_data_sources(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(200, [{"id": 1}]))
        assert client.list_data_sources() == [{"id": 1}]

    def test_get_data_source_schema_sync(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            return_value=_mock_response(
                200, {"schema": [{"name": "users", "columns": []}]}
            ),
        )
        out = client.get_data_source_schema(3)
        assert out[0]["name"] == "users"

    def test_execute_sql_inline(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            return_value=_mock_response(
                200,
                {
                    "query_result": {
                        "data": {"rows": [{"z": 3}], "columns": [{"name": "z"}]}
                    }
                },
            ),
        )
        out = client.execute_sql(2, "SELECT 1")
        assert out["data"]["rows"] == [{"z": 3}]


class TestRedashClientRequestBranches:
    def test_test_connection_success(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._session.request = MagicMock(
            return_value=_mock_response(200, {"results": []})
        )
        assert client.test_connection() == {"ok": True}

    @patch("activities.redash_client.time.sleep")
    def test_connection_error_then_success(self, mock_sleep):
        client = RedashClient("https://redash.example.com", "api-key")
        client._session.request = MagicMock(
            side_effect=[
                requests.ConnectionError("reset"),
                _mock_response(200, {"results": []}),
            ],
        )
        assert client.test_connection() == {"ok": True}
        assert client._session.request.call_count == 2
        mock_sleep.assert_called_once()

    def test_get_query_success(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            return_value=_mock_response(200, {"id": 7, "name": "q"})
        )
        assert client.get_query(7)["name"] == "q"

    def test_get_query_result_success(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            return_value=_mock_response(
                200,
                {"query_result": {"data": {"rows": [{"a": 1}]}}},
            ),
        )
        assert client.get_query_result(1)["data"]["rows"] == [{"a": 1}]

    def test_execute_query_404_returns_none(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(404))
        assert client.execute_query(9) is None

    def test_execute_query_inline_row_cap_returns_none(self):
        client = RedashClient(
            "https://redash.example.com", "api-key", max_result_rows=1
        )
        client._request = MagicMock(
            return_value=_mock_response(
                200,
                {"query_result": {"data": {"rows": [{"a": 1}, {"a": 2}]}}},
            ),
        )
        assert client.execute_query(9) is None

    def test_execute_query_no_job_returns_none(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(200, {}))
        assert client.execute_query(9) is None

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_execute_query_job_failure_raises(self, mock_mono, _mock_sleep):
        mock_mono.side_effect = [0.0, 0.0]
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"job": {"id": "job-fail"}}),
                _mock_response(200, {"job": {"status": 4, "error": "syntax error"}}),
            ],
        )
        with pytest.raises(RedashAPIError, match="failed"):
            client.execute_query(7, poll_interval=0.01)

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_execute_query_timeout_raises(self, mock_mono, _mock_sleep):
        mock_mono.side_effect = [0.0, 1000.0]
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"job": {"id": "job-slow"}}),
                _mock_response(200, {"job": {"status": 2}}),
            ],
        )
        with pytest.raises(RedashAPIError, match="timed out"):
            client.execute_query(7, poll_interval=0.01, poll_timeout=1.0)

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_get_data_source_schema_async_poll(self, mock_mono, _mock_sleep):
        mock_mono.side_effect = [0.0, 0.0, 0.0, 10.0]
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"job": {"id": "schema-job"}}),
                _mock_response(200, {"job": {"status": 3}}),
                _mock_response(200, {"schema": [{"name": "users", "columns": []}]}),
            ],
        )
        out = client.get_data_source_schema(4, poll_interval=0.01)
        assert out[0]["name"] == "users"

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_get_data_source_schema_job_failure(self, mock_mono, _mock_sleep):
        mock_mono.side_effect = [0.0, 0.0]
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"job": {"id": "schema-job"}}),
                _mock_response(200, {"job": {"status": 4, "error": "db down"}}),
            ],
        )
        with pytest.raises(RedashAPIError, match="Schema discovery"):
            client.get_data_source_schema(4, poll_interval=0.01)

    def test_get_data_source_schema_404_returns_empty(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(404))
        assert client.get_data_source_schema(4) == []

    @patch("activities.redash_client.time.sleep")
    @patch("activities.redash_client.time.monotonic")
    def test_execute_sql_async_poll(self, mock_mono, _mock_sleep):
        mock_mono.side_effect = [0.0, 0.0, 0.0, 10.0]
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"job": {"id": "sql-job"}}),
                _mock_response(200, {"job": {"status": 3, "query_result_id": 88}}),
                _mock_response(
                    200,
                    {"query_result": {"data": {"rows": [{"n": 1}], "columns": []}}},
                ),
            ],
        )
        out = client.execute_sql(2, "SELECT 1", poll_interval=0.01)
        assert out["data"]["rows"] == [{"n": 1}]

    def test_list_dashboards(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(
            side_effect=[
                _mock_response(200, {"results": [{"id": 1}]}),
            ],
        )
        assert client.list_dashboards() == [{"id": 1}]

    def test_get_dashboard_success(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(200, {"slug": "dash"}))
        assert client.get_dashboard("dash")["slug"] == "dash"

    def test_get_dashboard_404_returns_none(self):
        client = RedashClient("https://redash.example.com", "api-key")
        client._request = MagicMock(return_value=_mock_response(404))
        assert client.get_dashboard("missing") is None
