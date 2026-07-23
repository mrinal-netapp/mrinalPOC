"""Unit tests for the ONTAP MCP server helpers (server.py).

Only the module-level helper functions are exercised; the gated tool
registrations depend on import-time env and are intentionally not asserted here.
External clients are mocked so no network or ONTAP cluster is required.
"""

import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

# Keep observability bootstrap from writing to a non-existent relative path.
os.environ.setdefault(
    "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH",
    os.path.join(tempfile.gettempdir(), "mcp-server-ontap-test.jsonl"),
)

import server  # noqa: E402
from ontap_common.errors import (  # noqa: E402
    OntapAuthError,
    OntapError,
    OntapHTTPError,
    OntapTLSVerifyError,
)


# ---------------------------------------------------------------------------
# _allowed_tools
# ---------------------------------------------------------------------------

class TestAllowedTools:
    def test_empty_returns_read_tools(self, monkeypatch):
        monkeypatch.delenv("ONTAP_ALLOWED_TOOLS", raising=False)
        assert server._allowed_tools() == set(server.READ_TOOLS)

    def test_valid_subset(self, monkeypatch):
        monkeypatch.setenv("ONTAP_ALLOWED_TOOLS", "list_svms,create_volume")
        assert server._allowed_tools() == {"list_svms", "create_volume"}

    def test_unknown_names_ignored(self, monkeypatch):
        monkeypatch.setenv("ONTAP_ALLOWED_TOOLS", "list_svms,bogus_tool")
        assert server._allowed_tools() == {"list_svms"}

    def test_all_invalid_falls_back_to_read(self, monkeypatch):
        monkeypatch.setenv("ONTAP_ALLOWED_TOOLS", "bogus1,bogus2")
        assert server._allowed_tools() == set(server.READ_TOOLS)


# ---------------------------------------------------------------------------
# _redact
# ---------------------------------------------------------------------------

class TestRedact:
    def test_masks_sensitive_keys(self):
        out = server._redact({
            "password": "p",
            "api_token": "t",
            "client_secret": "s",
            "name": "vol1",
        })
        assert out["password"] == "***"
        assert out["api_token"] == "***"
        assert out["client_secret"] == "***"
        assert out["name"] == "vol1"


# ---------------------------------------------------------------------------
# _audit
# ---------------------------------------------------------------------------

class TestAudit:
    def test_emits_json_to_stdout(self, capsys, monkeypatch):
        monkeypatch.delenv("ONTAP_MCP_AUDIT_DEST", raising=False)
        monkeypatch.setenv("ONTAP_CLUSTER_URL", "https://c.example.com")
        server._audit("create_volume", {"name": "v1", "password": "x"}, "started")
        out = capsys.readouterr().out.strip()
        record = json.loads(out)
        assert record["audit"] is True
        assert record["tool"] == "create_volume"
        assert record["status"] == "started"
        assert record["cluster_url"] == "https://c.example.com"
        assert record["args"]["password"] == "***"
        assert "ts" in record

    def test_includes_error_when_failed(self, capsys, monkeypatch):
        monkeypatch.delenv("ONTAP_MCP_AUDIT_DEST", raising=False)
        server._audit("delete_volume", {"volume_uuid": "u"}, "failed", error="boom")
        record = json.loads(capsys.readouterr().out.strip())
        assert record["error"] == "boom"
        assert record["status"] == "failed"

    def test_routes_to_stderr(self, capsys, monkeypatch):
        monkeypatch.setenv("ONTAP_MCP_AUDIT_DEST", "stderr")
        server._audit("create_snapshot", {"name": "s"}, "ok")
        captured = capsys.readouterr()
        assert captured.out.strip() == ""
        record = json.loads(captured.err.strip())
        assert record["tool"] == "create_snapshot"


# ---------------------------------------------------------------------------
# _bool_env
# ---------------------------------------------------------------------------

class TestBoolEnv:
    def test_default_when_unset(self, monkeypatch):
        monkeypatch.delenv("SOME_FLAG", raising=False)
        assert server._bool_env("SOME_FLAG", default=True) is True
        assert server._bool_env("SOME_FLAG", default=False) is False

    @pytest.mark.parametrize("value", ["false", "0", "no", "off", "FALSE"])
    def test_falsey(self, monkeypatch, value):
        monkeypatch.setenv("SOME_FLAG", value)
        assert server._bool_env("SOME_FLAG") is False

    @pytest.mark.parametrize("value", ["true", "1", "yes", "on", "anything"])
    def test_truthy(self, monkeypatch, value):
        monkeypatch.setenv("SOME_FLAG", value)
        assert server._bool_env("SOME_FLAG") is True


# ---------------------------------------------------------------------------
# _build_credential
# ---------------------------------------------------------------------------

class TestBuildCredential:
    def _clear(self, monkeypatch):
        for k in (
            "ONTAP_USERNAME", "ONTAP_PASSWORD",
            "ONTAP_CLIENT_CERT_PATH", "ONTAP_CLIENT_KEY_PATH", "ONTAP_CA_BUNDLE_PATH",
        ):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setattr(server, "_MTLS_PATH_FALLBACK_WARNED", False)

    def test_basic_only(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("ONTAP_USERNAME", "admin")
        monkeypatch.setenv("ONTAP_PASSWORD", "secret")
        cred = server._build_credential()
        assert cred == {"username": "admin", "password": "secret"}

    def test_mtls_when_both_files_exist(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("ONTAP_CLIENT_CERT_PATH", "/etc/ontap/client.crt")
        monkeypatch.setenv("ONTAP_CLIENT_KEY_PATH", "/etc/ontap/client.key")
        monkeypatch.setattr(server.os.path, "isfile", lambda p: True)
        monkeypatch.setattr(server, "_read_pem", lambda path, label: f"PEM:{label}")
        cred = server._build_credential()
        assert cred["client_cert_pem"] == "PEM:client cert"
        assert cred["client_key_pem"] == "PEM:client key"

    def test_one_of_cert_key_raises(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("ONTAP_CLIENT_CERT_PATH", "/etc/ontap/client.crt")
        monkeypatch.setenv("ONTAP_CLIENT_KEY_PATH", "/etc/ontap/client.key")
        # cert exists but key does not -> XOR -> SystemExit
        monkeypatch.setattr(server.os.path, "isfile", lambda p: p.endswith(".crt"))
        with pytest.raises(SystemExit):
            server._build_credential()

    def test_paths_set_but_missing_falls_back_to_basic(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("ONTAP_USERNAME", "admin")
        monkeypatch.setenv("ONTAP_PASSWORD", "secret")
        monkeypatch.setenv("ONTAP_CLIENT_CERT_PATH", "/etc/ontap/client.crt")
        monkeypatch.setenv("ONTAP_CLIENT_KEY_PATH", "/etc/ontap/client.key")
        monkeypatch.setattr(server.os.path, "isfile", lambda p: False)
        cred = server._build_credential()
        assert cred == {"username": "admin", "password": "secret"}

    def test_ca_bundle_missing_raises(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("ONTAP_USERNAME", "admin")
        monkeypatch.setenv("ONTAP_PASSWORD", "secret")
        monkeypatch.setenv("ONTAP_CA_BUNDLE_PATH", "/etc/ontap/ca.pem")
        monkeypatch.setattr(server.os.path, "isfile", lambda p: False)
        with pytest.raises(SystemExit):
            server._build_credential()

    def test_ca_bundle_present(self, monkeypatch):
        self._clear(monkeypatch)
        monkeypatch.setenv("ONTAP_USERNAME", "admin")
        monkeypatch.setenv("ONTAP_PASSWORD", "secret")
        monkeypatch.setenv("ONTAP_CA_BUNDLE_PATH", "/etc/ontap/ca.pem")
        monkeypatch.setattr(server.os.path, "isfile", lambda p: True)
        monkeypatch.setattr(server, "_read_pem", lambda path, label: "CA")
        cred = server._build_credential()
        assert cred["ca_bundle_pem"] == "CA"

    def test_no_auth_raises(self, monkeypatch):
        self._clear(monkeypatch)
        with pytest.raises(SystemExit):
            server._build_credential()


# ---------------------------------------------------------------------------
# _read_pem
# ---------------------------------------------------------------------------

class TestReadPem:
    def test_reads_file(self, tmp_path):
        f = tmp_path / "x.pem"
        f.write_text("PEMDATA")
        assert server._read_pem(str(f), "cert") == "PEMDATA"

    def test_oserror_raises_systemexit(self, tmp_path):
        missing = str(tmp_path / "nope.pem")
        with pytest.raises(SystemExit):
            server._read_pem(missing, "cert")


# ---------------------------------------------------------------------------
# _ontap_client
# ---------------------------------------------------------------------------

class TestOntapClient:
    def test_missing_cluster_url_raises(self, monkeypatch):
        monkeypatch.delenv("ONTAP_CLUSTER_URL", raising=False)
        with pytest.raises(SystemExit):
            server._ontap_client()

    def test_builds_client(self, monkeypatch):
        monkeypatch.setenv("ONTAP_CLUSTER_URL", "https://c.example.com")
        monkeypatch.setattr(server, "_build_credential", lambda: {"username": "a", "password": "b"})
        sentinel = MagicMock()
        with patch.object(server, "OntapClient", return_value=sentinel) as ctor:
            client = server._ontap_client()
        assert client is sentinel
        _, kwargs = ctor.call_args
        assert kwargs["cluster_url"] == "https://c.example.com"


# ---------------------------------------------------------------------------
# _default_svm_or
# ---------------------------------------------------------------------------

class TestDefaultSvmOr:
    def test_explicit_value_wins(self, monkeypatch):
        monkeypatch.setenv("ONTAP_DEFAULT_SVM", "svm_default")
        assert server._default_svm_or("svm_explicit") == "svm_explicit"

    def test_falls_back_to_env(self, monkeypatch):
        monkeypatch.setenv("ONTAP_DEFAULT_SVM", "svm_default")
        assert server._default_svm_or(None) == "svm_default"
        assert server._default_svm_or("  ") == "svm_default"

    def test_none_when_neither(self, monkeypatch):
        monkeypatch.delenv("ONTAP_DEFAULT_SVM", raising=False)
        assert server._default_svm_or(None) is None


# ---------------------------------------------------------------------------
# _ontap_error
# ---------------------------------------------------------------------------

class TestOntapError:
    def test_tls_verify(self):
        out = server._ontap_error(OntapTLSVerifyError())
        assert out["error"]["code"] == "TLS_VERIFY_FAILED"
        assert "hint" in out["error"]

    def test_auth(self):
        out = server._ontap_error(OntapAuthError("nope"))
        assert out["error"]["code"] == "UNAUTHORIZED"

    def test_http_error(self):
        out = server._ontap_error(OntapHTTPError("500"))
        assert out["error"]["code"] == "PROVIDER_ERROR"

    def test_base_error(self):
        out = server._ontap_error(OntapError("x"))
        assert out["error"]["code"] == "PROVIDER_ERROR"

    def test_generic_exception(self):
        out = server._ontap_error(ValueError("weird"))
        assert out["error"]["code"] == "PROVIDER_ERROR"
        assert "weird" in out["error"]["message"]


# ---------------------------------------------------------------------------
# Tool bodies — reload the module with ALL tools enabled, then drive each tool
# with a mocked OntapClient so no cluster is required.
# ---------------------------------------------------------------------------

import importlib  # noqa: E402


@pytest.fixture(scope="module")
def all_tools_server():
    prev = os.environ.get("ONTAP_ALLOWED_TOOLS")
    os.environ["ONTAP_ALLOWED_TOOLS"] = ",".join(sorted(server.ALL_TOOLS))
    importlib.reload(server)
    yield server
    if prev is None:
        os.environ.pop("ONTAP_ALLOWED_TOOLS", None)
    else:
        os.environ["ONTAP_ALLOWED_TOOLS"] = prev
    importlib.reload(server)


def _tool_fn(srv_module, name):
    mcp = srv_module.mcp
    tm = getattr(mcp, "_tool_manager", None)
    if tm is not None and hasattr(tm, "_tools"):
        return tm._tools[name].fn
    import asyncio

    return asyncio.run(mcp.get_tool(name)).fn


def _mock_client(srv_module):
    client = MagicMock()
    client.__enter__.return_value = client
    client.__exit__.return_value = False
    client.get_paginated.return_value = MagicMock(records=[{"id": 1}], truncated=False)
    client.get.return_value = {"ok": True}
    client._request.return_value = {"ok": True}
    return client


class TestReadToolBodies:
    @pytest.mark.parametrize("name,kwargs", [
        ("list_svms", {}),
        ("list_volumes", {"svm_name": "svm1"}),
        ("list_volumes", {"svm_uuid": "u1"}),
        ("list_luns", {"svm_name": "svm1"}),
        ("list_luns", {"svm_uuid": "u1"}),
        ("list_snapshots", {"volume_uuid": "v1"}),
        ("list_aggregates", {}),
        ("list_network_interfaces", {}),
    ])
    def test_paginated_read_tools(self, all_tools_server, name, kwargs):
        client = _mock_client(all_tools_server)
        with patch.object(all_tools_server, "_ontap_client", return_value=client):
            out = _tool_fn(all_tools_server, name)(**kwargs)
        assert out == {"records": [{"id": 1}], "truncated": False}

    @pytest.mark.parametrize("name,kwargs", [
        ("get_volume", {"volume_uuid": "v1"}),
        ("get_cluster", {}),
        ("get_volume_metrics", {"volume_uuid": "v1"}),
    ])
    def test_single_get_read_tools(self, all_tools_server, name, kwargs):
        client = _mock_client(all_tools_server)
        with patch.object(all_tools_server, "_ontap_client", return_value=client):
            out = _tool_fn(all_tools_server, name)(**kwargs)
        assert out == {"ok": True}

    def test_read_tool_error_path(self, all_tools_server):
        with patch.object(all_tools_server, "_ontap_client", side_effect=OntapAuthError("nope")):
            out = _tool_fn(all_tools_server, "list_svms")()
        assert out["error"]["code"] == "UNAUTHORIZED"


class TestWriteToolBodies:
    @pytest.mark.parametrize("name,kwargs", [
        ("create_snapshot", {"volume_uuid": "v1", "name": "s1", "comment": "c"}),
        ("create_snapshot", {"volume_uuid": "v1", "name": "s1"}),
        ("delete_snapshot", {"volume_uuid": "v1", "snapshot_uuid": "su1"}),
        ("restore_snapshot", {"volume_uuid": "v1", "snapshot_name": "s1"}),
        ("create_volume", {"svm_name": "svm1", "name": "v1", "aggregate_name": "aggr1", "size_bytes": 1024, "junction_path": "/v1"}),
        ("create_volume", {"svm_name": "svm1", "name": "v1", "aggregate_name": "aggr1", "size_bytes": 1024}),
        ("delete_volume", {"volume_uuid": "v1"}),
        ("resize_volume", {"volume_uuid": "v1", "new_size_bytes": 2048}),
        ("set_volume_qos", {"volume_uuid": "v1", "policy_name": "gold"}),
        ("set_export_policy", {"volume_uuid": "v1", "export_policy_name": "default"}),
    ])
    def test_write_tools_success_and_audit(self, all_tools_server, capsys, name, kwargs):
        client = _mock_client(all_tools_server)
        with patch.object(all_tools_server, "_ontap_client", return_value=client):
            out = _tool_fn(all_tools_server, name)(**kwargs)
        assert out == {"ok": True}
        audit_lines = [
            l for l in capsys.readouterr().out.strip().splitlines() if '"audit":true' in l
        ]
        statuses = [json.loads(l)["status"] for l in audit_lines]
        assert "started" in statuses
        assert "ok" in statuses

    def test_write_tool_error_path_audits_failure(self, all_tools_server, capsys):
        with patch.object(all_tools_server, "_ontap_client", side_effect=OntapError("boom")):
            out = _tool_fn(all_tools_server, "delete_volume")(volume_uuid="v1")
        assert out["error"]["code"] == "PROVIDER_ERROR"
        statuses = [
            json.loads(l)["status"]
            for l in capsys.readouterr().out.strip().splitlines()
            if '"audit":true' in l
        ]
        assert "failed" in statuses
