"""Unit tests for the Redash provider adapter."""

from __future__ import annotations

from unittest.mock import patch

from activities.redash_client import RedashAPIError, RedashAuthError
from adapters.redash_adapter import RedashAdapter

CFG = {"base_url": "https://redash.example.com"}
CRED = {"api_key": "test-key"}


def _adapter() -> RedashAdapter:
    return RedashAdapter()


class TestDispatcher:
    @patch("adapters.redash_adapter.RedashClient")
    def test_unsupported_action(self, mock_cls):
        resp = _adapter().execute(CFG, CRED, "unknownAction", {})
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"
        mock_cls.assert_called_once()

    @patch("adapters.redash_adapter.RedashClient")
    def test_auth_error(self, mock_cls):
        mock_cls.return_value.test_connection.side_effect = RedashAuthError("bad key")
        resp = _adapter().execute(CFG, CRED, "testConnection", {})
        assert resp.error.code == "AUTH_ERROR"

    @patch("adapters.redash_adapter.RedashClient")
    def test_api_error(self, mock_cls):
        mock_cls.return_value.list_queries.side_effect = RedashAPIError("server down")
        resp = _adapter().execute(CFG, CRED, "listQueries", {})
        assert resp.error.code == "PROVIDER_ERROR"

    @patch("adapters.redash_adapter.RedashClient")
    def test_test_connection_success(self, mock_cls):
        resp = _adapter().execute(CFG, CRED, "testConnection", {})
        assert resp.error is None
        mock_cls.return_value.test_connection.assert_called_once()


class TestListRootFolders:
    def test_returns_three_folders(self):
        resp = _adapter().execute(CFG, CRED, "listRootFolders", {})
        assert resp.error is None
        assert len(resp.nodes) == 3
        labels = {n.label for n in resp.nodes}
        assert labels == {"Queries", "Dashboards", "Data Sources"}


class TestListQueries:
    @patch("adapters.redash_adapter.RedashClient")
    def test_skips_archived(self, mock_cls):
        mock_cls.return_value.list_queries.return_value = [
            {"id": 1, "name": "Active", "is_archived": False},
            {"id": 2, "name": "Old", "is_archived": True},
        ]
        resp = _adapter().execute(CFG, CRED, "listQueries", {})
        assert len(resp.nodes) == 1
        assert resp.nodes[0].label == "Active"


class TestListDashboards:
    @patch("adapters.redash_adapter.RedashClient")
    def test_maps_dashboard_nodes(self, mock_cls):
        mock_cls.return_value.list_dashboards.return_value = [
            {"id": 5, "slug": "sales", "name": "Sales", "is_archived": False},
        ]
        resp = _adapter().execute(CFG, CRED, "listDashboards", {})
        assert resp.nodes[0].resource == {"dashboard_slug": "sales"}


class TestListDataSources:
    @patch("adapters.redash_adapter.RedashClient")
    def test_maps_datasource_nodes(self, mock_cls):
        mock_cls.return_value.list_data_sources.return_value = [
            {"id": 3, "name": "Postgres", "type": "pg"},
        ]
        resp = _adapter().execute(CFG, CRED, "listDataSources", {})
        assert resp.nodes[0].type == "datasource"
        assert resp.nodes[0].actions == ["listDataSourceTables"]


class TestListDataSourceTables:
    @patch("adapters.redash_adapter.RedashClient")
    def test_requires_data_source_id(self, mock_cls):
        resp = _adapter().execute(CFG, CRED, "listDataSourceTables", {})
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.redash_adapter.RedashClient")
    def test_returns_table_nodes(self, mock_cls):
        mock_cls.return_value.get_data_source_schema.return_value = [
            {"name": "users", "columns": ["id", "name"]},
        ]
        resp = _adapter().execute(
            CFG,
            CRED,
            "listDataSourceTables",
            {"data_source_id": 3},
        )
        assert resp.nodes[0].label == "users"
        assert resp.nodes[0].metadata["column_count"] == 2

    @patch("adapters.redash_adapter.RedashClient")
    def test_schema_api_error(self, mock_cls):
        mock_cls.return_value.get_data_source_schema.side_effect = RedashAPIError(
            "fail"
        )
        resp = _adapter().execute(
            CFG,
            CRED,
            "listDataSourceTables",
            {"data_source_id": 3},
        )
        assert resp.error.code == "PROVIDER_ERROR"


class TestDescribeQuery:
    @patch("adapters.redash_adapter.RedashClient")
    def test_requires_query_id(self, mock_cls):
        resp = _adapter().execute(CFG, CRED, "describeQuery", {})
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.redash_adapter.RedashClient")
    def test_not_found(self, mock_cls):
        mock_cls.return_value.get_query.return_value = None
        resp = _adapter().execute(CFG, CRED, "describeQuery", {"query_id": 9})
        assert resp.error.code == "NOT_FOUND"

    @patch("adapters.redash_adapter.RedashClient")
    def test_describes_query_metadata(self, mock_cls):
        mock_cls.return_value.get_query.return_value = {
            "id": 9,
            "query": "SELECT 1",
            "schedule": {"interval": 3600},
            "data_source_id": 2,
        }
        resp = _adapter().execute(CFG, CRED, "describeQuery", {"query_id": 9})
        labels = {n.label for n in resp.nodes}
        assert {"SQL", "Schedule", "Data Source"} <= labels


class TestResolve:
    def test_merges_selector(self):
        out = _adapter().resolve(
            {"base_url": "https://redash.example.com"},
            CRED,
            {"query_id": 1},
        )
        assert out["query_id"] == 1
