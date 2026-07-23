"""Unit tests for credential resolution via config-service."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from activities import credentials as creds_mod


@pytest.fixture(autouse=True)
def clear_token_cache():
    creds_mod._token_cache["token"] = None
    creds_mod._token_cache["expires_at"] = 0
    yield
    creds_mod._token_cache["token"] = None
    creds_mod._token_cache["expires_at"] = 0


class TestGetServiceAccountToken:
    def test_returns_none_when_keycloak_unconfigured(self, monkeypatch):
        monkeypatch.delenv("KEYCLOAK_CLIENT_ID", raising=False)
        assert creds_mod._get_service_account_token() is None

    @patch("activities.credentials.requests.post")
    def test_fetches_and_caches_token(self, mock_post, monkeypatch):
        monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "client")
        monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "secret")
        monkeypatch.setenv("KEYCLOAK_TOKEN_URL", "http://keycloak/token")

        resp = MagicMock()
        resp.status_code = 200
        resp.json.return_value = {"access_token": "tok-1", "expires_in": 600}
        mock_post.return_value = resp

        assert creds_mod._get_service_account_token() == "tok-1"
        assert creds_mod._get_service_account_token() == "tok-1"
        mock_post.assert_called_once()

    @patch("activities.credentials.requests.post")
    def test_uses_cached_token(self, mock_post, monkeypatch):
        monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "client")
        monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "secret")
        monkeypatch.setenv("KEYCLOAK_TOKEN_URL", "http://keycloak/token")
        creds_mod._token_cache["token"] = "cached"
        creds_mod._token_cache["expires_at"] = time.time() + 300

        assert creds_mod._get_service_account_token() == "cached"
        mock_post.assert_not_called()

    @patch("activities.credentials.requests.post")
    def test_401_placeholder_secret_hint(self, mock_post, monkeypatch):
        monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "connector-worker")
        monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "changeme-abc")
        monkeypatch.setenv("KEYCLOAK_TOKEN_URL", "http://keycloak/token")

        resp = MagicMock()
        resp.status_code = 401
        resp.text = "unauthorized"
        mock_post.return_value = resp

        with pytest.raises(RuntimeError, match="placeholder"):
            creds_mod._get_service_account_token()


class TestResolveCredential:
    @patch(
        "activities.credentials._get_service_account_token", return_value="bearer-tok"
    )
    @patch("activities.credentials.requests.post")
    def test_posts_to_config_service(self, mock_post, _mock_token):
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"username": "u", "password": "p"}
        mock_post.return_value = resp

        out = creds_mod.resolve_credential(
            "http://config-service:3000",
            "proj-1",
            "cred-1",
        )

        assert out == {"username": "u", "password": "p"}
        args, kwargs = mock_post.call_args
        assert (
            args[0]
            == "http://config-service:3000/api/v1/projects/proj-1/credentials/cred-1/secret-data"
        )
        assert kwargs["headers"]["Authorization"] == "Bearer bearer-tok"

    @patch("activities.credentials._get_service_account_token", return_value=None)
    @patch("activities.credentials.requests.post")
    def test_falls_back_to_env_config_service_url(
        self, mock_post, _mock_token, monkeypatch
    ):
        monkeypatch.setenv("CONFIG_SERVICE_URL", "http://config-from-env:3000")
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"api_key": "k"}
        mock_post.return_value = resp

        out = creds_mod.resolve_credential("", "proj-1", "cred-1")

        assert out["api_key"] == "k"
        assert mock_post.call_args[0][0].startswith("http://config-from-env:3000/")

    @patch("activities.credentials._get_service_account_token", return_value=None)
    @patch("activities.credentials.requests.post")
    def test_falls_back_when_url_has_no_scheme(
        self, mock_post, _mock_token, monkeypatch
    ):
        monkeypatch.delenv("CONFIG_SERVICE_URL", raising=False)
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"token": "t"}
        mock_post.return_value = resp

        creds_mod.resolve_credential("my-config-host:4000", "proj-1", "cred-1")

        assert (
            mock_post.call_args[0][0]
            == "http://config-service:3000/api/v1/projects/proj-1/credentials/cred-1/secret-data"
        )
