"""Unit tests for ontap_common.client (shared ONTAP REST client).

External HTTP is mocked via the session's ``request`` method; no network is used.
"""

import os
from unittest.mock import MagicMock

import pytest
import requests

from ontap_common.client import (
    OntapClient,
    PaginatedResult,
    _coerce_verify_tls_bool,
    split_host_port,
    verify_tls_from_connector_config,
)
from ontap_common.errors import (
    OntapAuthError,
    OntapHTTPError,
    OntapNetworkError,
    OntapTimeoutError,
    OntapTLSVerifyError,
)

BASIC_CRED = {"username": "admin", "password": "secret"}


# ---------------------------------------------------------------------------
# _coerce_verify_tls_bool
# ---------------------------------------------------------------------------

class TestCoerceVerifyTlsBool:
    @pytest.mark.parametrize("value,expected", [
        (True, True),
        (False, False),
        (0, False),
        (1, True),
        (2.0, True),
        (0.0, False),
        ("false", False),
        ("0", False),
        ("no", False),
        ("off", False),
        ("true", True),
        ("1", True),
        ("yes", True),
        ("on", True),
        ("TRUE", True),
    ])
    def test_variants(self, value, expected):
        assert _coerce_verify_tls_bool(value) is expected

    def test_unknown_returns_default(self):
        assert _coerce_verify_tls_bool("maybe") is True
        assert _coerce_verify_tls_bool("maybe", default=False) is False
        assert _coerce_verify_tls_bool(None) is True


# ---------------------------------------------------------------------------
# verify_tls_from_connector_config
# ---------------------------------------------------------------------------

class TestVerifyTlsFromConnectorConfig:
    def test_canonical_key(self):
        assert verify_tls_from_connector_config({"verify_tls": False}) is False

    def test_camel_case_fallback(self):
        assert verify_tls_from_connector_config({"verifyTls": "false"}) is False

    def test_legacy_verify_ssl_fallback(self):
        assert verify_tls_from_connector_config({"verify_ssl": "0"}) is False

    def test_precedence_canonical_wins(self):
        cfg = {"verify_tls": True, "verifyTls": False, "verify_ssl": False}
        assert verify_tls_from_connector_config(cfg) is True

    def test_absent_defaults_true(self):
        assert verify_tls_from_connector_config({}) is True


# ---------------------------------------------------------------------------
# split_host_port
# ---------------------------------------------------------------------------

class TestSplitHostPort:
    def test_https_default_443(self):
        assert split_host_port("https://cluster.example.com") == ("cluster.example.com", 443)

    def test_http_default_80(self):
        assert split_host_port("http://lab-cluster") == ("lab-cluster", 80)

    def test_explicit_port(self):
        assert split_host_port("https://cluster.example.com:8443/api") == ("cluster.example.com", 8443)


# ---------------------------------------------------------------------------
# OntapClient.__init__ / _build_url
# ---------------------------------------------------------------------------

class TestInitAndUrl:
    def test_empty_cluster_url_raises(self):
        with pytest.raises(ValueError):
            OntapClient(cluster_url="", credential=BASIC_CRED)

    def test_strips_trailing_slash(self):
        client = OntapClient(cluster_url="https://c.example.com/", credential=BASIC_CRED)
        assert client.base_url == "https://c.example.com"

    def test_build_url_absolute_passthrough(self):
        client = OntapClient(cluster_url="https://c.example.com", credential=BASIC_CRED)
        assert client._build_url("https://other.com/x") == "https://other.com/x"

    def test_build_url_leading_slash(self):
        client = OntapClient(cluster_url="https://c.example.com", credential=BASIC_CRED)
        assert client._build_url("/api/cluster") == "https://c.example.com/api/cluster"

    def test_build_url_relative(self):
        client = OntapClient(cluster_url="https://c.example.com", credential=BASIC_CRED)
        assert client._build_url("api/cluster") == "https://c.example.com/api/cluster"


# ---------------------------------------------------------------------------
# _build_session — auth selection
# ---------------------------------------------------------------------------

class TestBuildSession:
    def test_basic_auth(self):
        client = OntapClient(cluster_url="https://c", credential=BASIC_CRED)
        with client as bound:
            assert bound._session.auth == ("admin", "secret")
            assert bound._session.cert is None

    def test_neither_credential_raises(self):
        client = OntapClient(cluster_url="https://c", credential={})
        with pytest.raises(OntapAuthError):
            client.__enter__()

    def test_verify_false(self):
        client = OntapClient(cluster_url="https://c", credential=BASIC_CRED, verify_tls=False)
        with client as bound:
            assert bound._session.verify is False
            assert bound._request_verify is False

    def test_verify_true_default(self):
        client = OntapClient(cluster_url="https://c", credential=BASIC_CRED)
        with client as bound:
            assert bound._session.verify is True
            assert bound._request_verify is True

    def test_mtls_cert_key(self):
        cred = {"client_cert_pem": "CERTDATA", "client_key_pem": "KEYDATA"}
        client = OntapClient(cluster_url="https://c", credential=cred)
        with client as bound:
            cert_path, key_path = bound._session.cert
            assert os.path.isfile(cert_path)
            assert os.path.isfile(key_path)
        # temp files cleaned up on exit
        assert not os.path.isfile(cert_path)
        assert not os.path.isfile(key_path)

    def test_ca_bundle_sets_verify_path(self):
        cred = dict(BASIC_CRED, ca_bundle_pem="CADATA")
        client = OntapClient(cluster_url="https://c", credential=cred)
        with client as bound:
            ca_path = bound._session.verify
            assert os.path.isfile(ca_path)
            assert bound._request_verify == ca_path
        assert not os.path.isfile(ca_path)


# ---------------------------------------------------------------------------
# _request — error mapping
# ---------------------------------------------------------------------------

def _client_with_mocked_request(side_effect=None, return_value=None):
    client = OntapClient(cluster_url="https://c", credential=BASIC_CRED)
    session = client._build_session()
    session.request = MagicMock(side_effect=side_effect, return_value=return_value)
    client._build_session = lambda: session
    return client


def _resp(status_code=200, content=b'{}', json_value=None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.content = content
    resp.text = content.decode() if isinstance(content, bytes) else str(content)
    if json_value is not None:
        resp.json.return_value = json_value
    return resp


class TestRequestErrorMapping:
    def test_ssl_error(self):
        client = _client_with_mocked_request(side_effect=requests.exceptions.SSLError("x"))
        with pytest.raises(OntapTLSVerifyError):
            client._request("GET", "/api/cluster")

    def test_connect_timeout(self):
        client = _client_with_mocked_request(side_effect=requests.exceptions.ConnectTimeout("x"))
        with pytest.raises(OntapTimeoutError):
            client._request("GET", "/api/cluster")

    def test_read_timeout(self):
        client = _client_with_mocked_request(side_effect=requests.exceptions.ReadTimeout("x"))
        with pytest.raises(OntapTimeoutError):
            client._request("GET", "/api/cluster")

    def test_connection_error(self):
        client = _client_with_mocked_request(side_effect=requests.exceptions.ConnectionError("x"))
        with pytest.raises(OntapNetworkError):
            client._request("GET", "/api/cluster")

    def test_generic_request_exception(self):
        client = _client_with_mocked_request(side_effect=requests.RequestException("x"))
        with pytest.raises(OntapNetworkError):
            client._request("GET", "/api/cluster")

    @pytest.mark.parametrize("status", [401, 403])
    def test_auth_error(self, status):
        client = _client_with_mocked_request(return_value=_resp(status_code=status))
        with pytest.raises(OntapAuthError):
            client._request("GET", "/api/cluster")

    def test_http_error_5xx(self):
        client = _client_with_mocked_request(return_value=_resp(status_code=500, content=b"boom"))
        with pytest.raises(OntapHTTPError):
            client._request("GET", "/api/cluster")

    def test_empty_body_returns_empty_dict(self):
        client = _client_with_mocked_request(return_value=_resp(status_code=200, content=b""))
        assert client._request("GET", "/api/cluster") == {}

    def test_invalid_json_raises_http_error(self):
        resp = _resp(status_code=200, content=b"not json")
        resp.json.side_effect = ValueError("bad json")
        client = _client_with_mocked_request(return_value=resp)
        with pytest.raises(OntapHTTPError):
            client._request("GET", "/api/cluster")

    def test_success_returns_dict(self):
        client = _client_with_mocked_request(
            return_value=_resp(status_code=200, content=b'{"a":1}', json_value={"a": 1})
        )
        assert client._request("GET", "/api/cluster") == {"a": 1}

    def test_adhoc_request_without_context_manager(self):
        client = OntapClient(cluster_url="https://c", credential=BASIC_CRED)
        # No __enter__ called; _request should build a one-shot session.
        captured = {}
        real_build = client._build_session

        def _build():
            session = real_build()
            session.request = MagicMock(
                return_value=_resp(status_code=200, content=b'{"ok":1}', json_value={"ok": 1})
            )
            captured["session"] = session
            return session

        client._build_session = _build
        assert client._request("GET", "/api/cluster") == {"ok": 1}
        assert "session" in captured


# ---------------------------------------------------------------------------
# get_paginated
# ---------------------------------------------------------------------------

class TestGetPaginated:
    def _client(self):
        return OntapClient(cluster_url="https://c", credential=BASIC_CRED)

    def test_single_page(self):
        client = self._client()
        client._request = MagicMock(return_value={"records": [{"id": 1}, {"id": 2}]})
        result = client.get_paginated("/api/storage/volumes")
        assert isinstance(result, PaginatedResult)
        assert result.records == [{"id": 1}, {"id": 2}]
        assert result.truncated is False

    def test_multi_page_follows_next_link(self):
        client = self._client()
        client._request = MagicMock(side_effect=[
            {"records": [{"id": 1}], "_links": {"next": {"href": "/api/storage/volumes?page=2"}}},
            {"records": [{"id": 2}]},
        ])
        result = client.get_paginated("/api/storage/volumes")
        assert result.records == [{"id": 1}, {"id": 2}]
        assert result.truncated is False
        # Second call must not re-send params (href already encodes them).
        second_call = client._request.call_args_list[1]
        assert second_call.kwargs["params"] is None

    def test_max_records_cap_truncates(self):
        client = self._client()
        client._request = MagicMock(return_value={
            "records": [{"id": i} for i in range(10)],
        })
        result = client.get_paginated("/api/storage/volumes", max_records=5)
        assert len(result.records) == 5
        assert result.truncated is True

    def test_num_records_captured_as_total(self):
        client = self._client()
        client._request = MagicMock(return_value={"records": [{"id": 1}], "num_records": 1})
        result = client.get_paginated("/api/storage/volumes")
        assert result.total_records == 1
