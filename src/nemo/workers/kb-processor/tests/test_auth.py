"""Unit tests for utils/auth.py: OAuth2 client-credentials token fetching,
per-client token caching with expiry, and authenticated-session construction.
"""

import importlib.util
import sys
from pathlib import Path
from unittest import mock

import pytest
import requests

# Must run before the `utils.auth` imports below: conftest.py normally
# inserts the kb-processor root into sys.path first, but this module should
# not rely on that when run outside of a full pytest session (e.g. `python
# -m unittest tests.test_auth`).
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import utils.auth as auth_mod
from utils.auth import clear_token_cache, get_access_token, get_authenticated_session


def _load_auth():
    """Load a fresh, independent copy of ``utils/auth.py`` (its own module
    globals, including its own ``_token_cache``) so the expiry tests below
    can drive a fake clock without touching the shared module-level cache
    used by the rest of this file.
    """
    spec = importlib.util.spec_from_file_location(
        "kb_processor_auth", _ROOT / "utils" / "auth.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class _FakeResp:
    def __init__(self, token: str, expires_in: int) -> None:
        self._token = token
        self._expires_in = expires_in

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return {"access_token": self._token, "expires_in": self._expires_in}


@pytest.fixture(autouse=True)
def _reset_token_cache():
    clear_token_cache()
    yield
    clear_token_cache()


def _fake_response(payload, raise_exc=None):
    resp = mock.Mock()
    if raise_exc:
        resp.raise_for_status.side_effect = raise_exc
    else:
        resp.raise_for_status.return_value = None
    resp.json.return_value = payload
    return resp


def test_token_cached_until_expiry_then_refetched(monkeypatch):
    """A cached token is reused within its TTL and refetched once it expires."""
    mod = _load_auth()

    clock = {"t": 1000.0}
    monkeypatch.setattr(mod.time, "monotonic", lambda: clock["t"])

    calls = {"n": 0}
    tokens = ["tok-0", "tok-1"]

    def fake_post(_url, **_kwargs):
        i = calls["n"]
        calls["n"] += 1
        return _FakeResp(tokens[i], expires_in=300)

    monkeypatch.setattr(mod.requests, "post", fake_post)

    # First call fetches (300s lifetime - 30s skew => cached for 270s).
    assert mod.get_access_token("http://kc/realms/nemo", "cid", "sec") == "tok-0"
    assert calls["n"] == 1

    # Within TTL: served from cache, no new HTTP call.
    clock["t"] += 200
    assert mod.get_access_token("http://kc/realms/nemo", "cid", "sec") == "tok-0"
    assert calls["n"] == 1

    # Past TTL (total +300 > 270): a fresh token is fetched. This is the
    # regression guard for the never-expiring global that 401'd old pods.
    clock["t"] += 100
    assert mod.get_access_token("http://kc/realms/nemo", "cid", "sec") == "tok-1"
    assert calls["n"] == 2


def test_distinct_clients_do_not_share_token(monkeypatch):
    """Different credentials get their own cache entry, not the first token."""
    mod = _load_auth()
    monkeypatch.setattr(mod.time, "monotonic", lambda: 0.0)

    seq = iter(["tok-a", "tok-b"])
    monkeypatch.setattr(
        mod.requests, "post", lambda _url, **_k: _FakeResp(next(seq), expires_in=300)
    )

    a = mod.get_access_token("http://kc/realms/nemo", "client-a", "sec-a")
    b = mod.get_access_token("http://kc/realms/nemo", "client-b", "sec-b")
    assert a == "tok-a"
    assert b == "tok-b"


class TestGetAccessToken:
    @mock.patch("requests.post")
    def test_fetches_and_returns_token(self, mock_post):
        mock_post.return_value = _fake_response({"access_token": "tok-1"})
        token = get_access_token("http://keycloak/realms/nemo", "cid", "secret")
        assert token == "tok-1"

    @mock.patch("requests.post")
    def test_sends_expected_request_params(self, mock_post):
        mock_post.return_value = _fake_response({"access_token": "tok-1"})
        get_access_token("http://keycloak/realms/nemo", "cid", "secret")

        args, kwargs = mock_post.call_args
        assert args[0] == "http://keycloak/realms/nemo/protocol/openid-connect/token"
        assert kwargs["data"] == {
            "grant_type": "client_credentials",
            "client_id": "cid",
            "client_secret": "secret",
            "scope": "openid profile email",
        }
        assert kwargs["headers"] == {"Content-Type": "application/x-www-form-urlencoded"}
        assert kwargs["timeout"] == 10

    @mock.patch("requests.post")
    def test_caches_token_by_default(self, mock_post):
        mock_post.return_value = _fake_response({"access_token": "tok-1"})
        first = get_access_token("http://kc", "cid", "secret")
        second = get_access_token("http://kc", "cid", "secret")
        assert first == second == "tok-1"
        mock_post.assert_called_once()

    @mock.patch("requests.post")
    def test_use_cache_false_always_refetches(self, mock_post):
        mock_post.side_effect = [
            _fake_response({"access_token": "tok-1"}),
            _fake_response({"access_token": "tok-2"}),
        ]
        first = get_access_token("http://kc", "cid", "secret")
        second = get_access_token("http://kc", "cid", "secret", use_cache=False)
        assert first == "tok-1"
        assert second == "tok-2"
        assert mock_post.call_count == 2

    @mock.patch("requests.post")
    def test_use_cache_false_does_not_populate_cache(self, mock_post):
        mock_post.return_value = _fake_response({"access_token": "tok-1"})
        get_access_token("http://kc", "cid", "secret", use_cache=False)
        # _token_cache is keyed by (keycloak_url, client_id, client_secret);
        # a use_cache=False call must never write an entry for that key.
        assert auth_mod._token_cache == {}

    @mock.patch("requests.post")
    def test_http_error_is_raised_and_logged(self, mock_post):
        mock_post.return_value = _fake_response(
            {}, raise_exc=requests.exceptions.HTTPError("500")
        )
        with pytest.raises(requests.exceptions.HTTPError):
            get_access_token("http://kc", "cid", "secret")

    @mock.patch("requests.post", side_effect=requests.exceptions.ConnectionError("down"))
    def test_connection_error_is_raised(self, mock_post):
        with pytest.raises(requests.exceptions.ConnectionError):
            get_access_token("http://kc", "cid", "secret")

    @mock.patch("requests.post")
    def test_missing_access_token_key_raises_key_error(self, mock_post):
        mock_post.return_value = _fake_response({"unexpected": "shape"})
        with pytest.raises(KeyError):
            get_access_token("http://kc", "cid", "secret")


class TestGetAuthenticatedSession:
    @mock.patch("requests.post")
    def test_session_has_bearer_auth_header(self, mock_post):
        mock_post.return_value = _fake_response({"access_token": "tok-1"})
        session = get_authenticated_session("http://kc", "cid", "secret")
        assert isinstance(session, requests.Session)
        assert session.headers["Authorization"] == "Bearer tok-1"
        assert session.headers["Content-Type"] == "application/json"

    @mock.patch("requests.post")
    def test_reuses_cached_token(self, mock_post):
        mock_post.return_value = _fake_response({"access_token": "tok-1"})
        get_access_token("http://kc", "cid", "secret")
        session = get_authenticated_session("http://kc", "cid", "secret")
        assert session.headers["Authorization"] == "Bearer tok-1"
        mock_post.assert_called_once()


class TestClearTokenCache:
    @mock.patch("requests.post")
    def test_clears_cache_forcing_refetch(self, mock_post):
        mock_post.side_effect = [
            _fake_response({"access_token": "tok-1"}),
            _fake_response({"access_token": "tok-2"}),
        ]
        first = get_access_token("http://kc", "cid", "secret")
        clear_token_cache()
        second = get_access_token("http://kc", "cid", "secret")
        assert first == "tok-1"
        assert second == "tok-2"
        assert mock_post.call_count == 2
