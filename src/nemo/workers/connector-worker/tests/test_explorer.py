"""Unit tests for explorer and provider connection activities."""

from __future__ import annotations

from unittest.mock import patch

import pytest
import requests

pytest.importorskip("temporalio")

from activities import explorer as ex
from adapters.base import ExplorerError, ExplorerNode, ExplorerResponse


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


class _FakeAdapter:
    def __init__(self, *, execute_resp=None, resolve_resp=None, execute_exc=None):
        self._execute_resp = execute_resp
        self._resolve_resp = resolve_resp
        self._execute_exc = execute_exc

    def execute(self, connector_config, credential, action, payload):
        if self._execute_exc:
            raise self._execute_exc
        return self._execute_resp or ExplorerResponse()

    def resolve(self, connector_config, credential, resource_selector):
        return self._resolve_resp or {"merged": True}


@pytest.fixture(autouse=True)
def patch_heartbeat(monkeypatch):
    monkeypatch.setattr(
        "activities.explorer.activity.heartbeat", lambda *_a, **_k: None
    )


def _explorer_input(**overrides):
    body = {
        "provider": "ontap",
        "action": "listVolumes",
        "connectorConfig": {"cluster_url": "https://ontap.example.com"},
        "payload": {},
        "projectId": "proj-1",
        "credentialId": "cred-1",
        "configServiceUrl": "http://config-service:3000",
        "connectorId": "conn-1",
    }
    body.update(overrides)
    return body


class TestExplorerAction:
    @patch("activities.explorer.registry.get", return_value=None)
    def test_unknown_provider(self, _mock_get):
        out = _call_activity(ex.explorer_action, _explorer_input(provider="missing"))
        assert out["error"]["code"] == "ADAPTER_NOT_FOUND"

    @patch(
        "activities.explorer.resolve_credential",
        side_effect=RuntimeError("auth failed"),
    )
    @patch("activities.explorer.registry.get")
    def test_credential_error(self, mock_get, _mock_cred):
        mock_get.return_value = _FakeAdapter()
        out = _call_activity(ex.explorer_action, _explorer_input())
        assert out["error"]["code"] == "CREDENTIAL_ERROR"

    @patch("activities.explorer.resolve_credential", return_value={"username": "u"})
    @patch("activities.explorer.registry.get")
    def test_adapter_success(self, mock_get, _mock_cred):
        resp = ExplorerResponse(
            nodes=[ExplorerNode(id="1", label="vol1", type="volume")]
        )
        mock_get.return_value = _FakeAdapter(execute_resp=resp)
        out = _call_activity(ex.explorer_action, _explorer_input())
        assert out["nodes"][0]["label"] == "vol1"

    @patch("activities.explorer.resolve_credential", return_value={})
    @patch("activities.explorer.registry.get")
    def test_adapter_exception_becomes_provider_error(self, mock_get, _mock_cred):
        mock_get.return_value = _FakeAdapter(execute_exc=RuntimeError("boom"))
        out = _call_activity(ex.explorer_action, _explorer_input())
        assert out["error"]["code"] == "PROVIDER_ERROR"


class TestResolveResource:
    def test_account_scope_requires_selector(self):
        out = _call_activity(
            ex.resolve_resource,
            {"provider": "s3", "scope": "account", "resourceSelector": {}},
        )
        assert out["success"] is False

    @patch("activities.explorer.registry.get", return_value=None)
    def test_unknown_provider(self, _mock_get):
        out = _call_activity(ex.resolve_resource, {"provider": "missing"})
        assert out["success"] is False

    @patch("activities.explorer.resolve_credential", return_value={"key": "k"})
    @patch("activities.explorer.registry.get")
    def test_success(self, mock_get, _mock_cred):
        mock_get.return_value = _FakeAdapter(resolve_resp={"bucket": "b1"})
        out = _call_activity(
            ex.resolve_resource,
            {
                "provider": "s3",
                "connectorConfig": {"region": "us-east-1"},
                "resourceSelector": {"bucket": "b1"},
                "projectId": "p1",
                "credentialId": "c1",
                "configServiceUrl": "http://config-service:3000",
            },
        )
        assert out["success"] is True
        assert out["effectiveConfig"]["bucket"] == "b1"


class TestTestProviderConnection:
    def test_requires_provider_in_config(self):
        out = _call_activity(ex.test_provider_connection, {"connectorConfig": {}})
        assert out["success"] is False

    @patch("activities.explorer.registry.get", return_value=None)
    def test_unknown_provider(self, _mock_get):
        out = _call_activity(
            ex.test_provider_connection,
            {"connectorConfig": {"provider": "missing"}},
        )
        assert out["success"] is False

    @patch(
        "activities.explorer.resolve_credential", side_effect=RuntimeError("no creds")
    )
    @patch("activities.explorer.registry.get")
    def test_credential_error(self, mock_get, _mock_cred):
        mock_get.return_value = _FakeAdapter()
        out = _call_activity(
            ex.test_provider_connection,
            {"connectorConfig": {"provider": "ontap"}},
        )
        assert out["success"] is False
        assert out["code"] == "CREDENTIAL_ERROR"

    @patch("activities.explorer.resolve_credential", return_value={})
    @patch("activities.explorer.registry.get")
    def test_tls_verify_failed(self, mock_get, _mock_cred):
        mock_get.return_value = _FakeAdapter(
            execute_exc=requests.exceptions.SSLError("certificate verify failed"),
        )
        out = _call_activity(
            ex.test_provider_connection,
            {"connectorConfig": {"provider": "ontap"}},
        )
        assert out["success"] is False
        assert out["code"] == "TLS_VERIFY_FAILED"

    @patch("activities.explorer.resolve_credential", return_value={})
    @patch("activities.explorer.registry.get")
    def test_adapter_error_envelope(self, mock_get, _mock_cred):
        resp = ExplorerResponse(error=ExplorerError("AUTH", "bad password"))
        mock_get.return_value = _FakeAdapter(execute_resp=resp)
        out = _call_activity(
            ex.test_provider_connection,
            {"connectorConfig": {"provider": "ontap"}},
        )
        assert out["success"] is False
        assert out["code"] == "AUTH"

    @patch("activities.explorer.resolve_credential", return_value={})
    @patch("activities.explorer.registry.get")
    def test_success_with_version(self, mock_get, _mock_cred):
        resp = ExplorerResponse(
            nodes=[
                ExplorerNode(
                    id="c1",
                    label="cluster1",
                    type="cluster",
                    metadata={"version": "9.13.1"},
                ),
            ],
        )
        mock_get.return_value = _FakeAdapter(execute_resp=resp)
        out = _call_activity(
            ex.test_provider_connection,
            {"connectorConfig": {"provider": "ontap"}},
        )
        assert out["success"] is True
        assert "version 9.13.1" in out["message"]
