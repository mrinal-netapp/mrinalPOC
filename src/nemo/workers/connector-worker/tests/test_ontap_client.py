"""Unit tests for ontap_common.client.OntapClient."""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest
import requests

from ontap_common import (
    OntapAuthError,
    OntapClient,
    OntapHTTPError,
    OntapNetworkError,
    OntapTLSVerifyError,
    OntapTimeoutError,
    verify_tls_from_connector_config,
)


def _resp(status: int, json_body=None, content: bytes | None = None):
    r = MagicMock()
    r.status_code = status
    r.text = "" if content is None else content.decode("utf-8", errors="replace")
    r.content = (
        content if content is not None else (b"{}" if json_body is None else b"X")
    )
    r.json = MagicMock(return_value=json_body if json_body is not None else {})
    return r


class TestVerifyTlsFromConnectorConfig:
    def test_defaults_true_when_missing(self):
        assert verify_tls_from_connector_config({}) is True

    def test_coerce_int_zero(self):
        assert verify_tls_from_connector_config({"verify_tls": 0}) is False

    def test_coerce_string_off(self):
        assert verify_tls_from_connector_config({"verify_tls": "off"}) is False

    def test_coerce_string_on(self):
        assert verify_tls_from_connector_config({"verify_tls": "yes"}) is True

    def test_snake_false(self):
        assert verify_tls_from_connector_config({"verify_tls": False}) is False

    def test_camel_false(self):
        assert verify_tls_from_connector_config({"verifyTls": False}) is False

    def test_verify_tls_wins_over_verify_ssl(self):
        assert (
            verify_tls_from_connector_config({"verify_tls": True, "verify_ssl": False})
            is True
        )

    def test_verify_ssl_fallback(self):
        assert verify_tls_from_connector_config({"verify_ssl": False}) is False


class TestAuthSelection:
    def test_basic_auth_used_when_creds_present(self):
        client = OntapClient(
            "https://ontap.example.com",
            credential={"username": "u", "password": "p"},
            verify_tls=True,
        )
        with client as bound:
            assert bound._session is not None
            assert bound._session.auth == ("u", "p")
            assert bound._session.cert is None or bound._session.cert == ()

    def test_mtls_takes_precedence_over_basic(self):
        client = OntapClient(
            "https://ontap.example.com",
            credential={
                "username": "u",
                "password": "p",
                "client_cert_pem": "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----",
                "client_key_pem": "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
            },
            verify_tls=True,
        )
        with client as bound:
            cert = bound._session.cert
            assert isinstance(cert, tuple) and len(cert) == 2
            cert_path, key_path = cert
            assert os.path.exists(cert_path)
            assert os.path.exists(key_path)
            mode_cert = os.stat(cert_path).st_mode & 0o777
            assert mode_cert == 0o600
        assert not os.path.exists(cert_path)
        assert not os.path.exists(key_path)

    def test_missing_both_auth_modes_raises(self):
        client = OntapClient(
            "https://ontap.example.com",
            credential={},
            verify_tls=True,
        )
        with pytest.raises(OntapAuthError):
            client.__enter__()


class TestErrorMapping:
    @patch("requests.Session.request")
    def test_connect_timeout_maps_to_timeout_error(self, mock_request):
        mock_request.side_effect = requests.exceptions.ConnectTimeout("connect timeout")
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            with pytest.raises(OntapTimeoutError):
                bound.get("/api/cluster")

    @patch("requests.Session.request")
    def test_read_timeout_maps_to_timeout_error(self, mock_request):
        mock_request.side_effect = requests.exceptions.ReadTimeout("read timeout")
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            with pytest.raises(OntapTimeoutError):
                bound.get("/api/cluster")

    @patch("requests.Session.request")
    def test_connection_error_maps_to_network_error(self, mock_request):
        mock_request.side_effect = requests.exceptions.ConnectionError("conn reset")
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            with pytest.raises(OntapNetworkError):
                bound.get("/api/cluster")

    @patch("requests.Session.request")
    def test_ssl_error_maps_to_tls_verify_failed(self, mock_request):
        mock_request.side_effect = requests.exceptions.SSLError("self-signed")
        client = OntapClient(
            "https://ontap.example.com",
            credential={"username": "u", "password": "p"},
        )
        with client as bound:
            with pytest.raises(OntapTLSVerifyError):
                bound.get("/api/cluster")

    @patch("requests.Session.request")
    def test_401_maps_to_auth_error(self, mock_request):
        mock_request.return_value = _resp(401)
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            with pytest.raises(OntapAuthError):
                bound.get("/api/cluster")

    @patch("requests.Session.request")
    def test_500_maps_to_http_error(self, mock_request):
        mock_request.return_value = _resp(500, content=b"boom")
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            with pytest.raises(OntapHTTPError):
                bound.get("/api/cluster")


class TestPagination:
    @patch("requests.Session.request")
    def test_follows_next_link_until_no_next(self, mock_request):
        page1 = _resp(
            200,
            json_body={
                "records": [{"id": 1}, {"id": 2}],
                "_links": {"next": {"href": "/api/storage/volumes?next=cursor1"}},
                "num_records": 2,
            },
        )
        page2 = _resp(
            200,
            json_body={
                "records": [{"id": 3}],
                "_links": {},
            },
        )
        mock_request.side_effect = [page1, page2]
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            page = bound.get_paginated("/api/storage/volumes", page_size=2)
        assert [r["id"] for r in page.records] == [1, 2, 3]
        assert page.truncated is False

    @patch("requests.Session.request")
    def test_caps_at_max_records(self, mock_request):
        # Two pages each with 5 records, but we cap at 7.
        page1 = _resp(
            200,
            json_body={
                "records": [{"id": i} for i in range(5)],
                "_links": {"next": {"href": "/api/storage/volumes?next=cursor1"}},
            },
        )
        page2 = _resp(
            200,
            json_body={
                "records": [{"id": i} for i in range(5, 10)],
                "_links": {"next": {"href": "/api/storage/volumes?next=cursor2"}},
            },
        )
        mock_request.side_effect = [page1, page2]
        client = OntapClient("https://x", credential={"username": "u", "password": "p"})
        with client as bound:
            page = bound.get_paginated(
                "/api/storage/volumes", max_records=7, page_size=5
            )
        assert len(page.records) == 7
        assert page.truncated is True
