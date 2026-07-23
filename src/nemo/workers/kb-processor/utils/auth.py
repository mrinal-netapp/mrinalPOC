"""Authentication utilities for KB processor."""

import threading
import time

import requests
from observability_client_runtime import get_logger

logger = get_logger()

# Refresh a little before the real expiry so an in-flight request never races
# the token lifetime (Keycloak access tokens are short — 5 min in this realm).
_EXPIRY_SKEW_SECONDS = 30

# Per-(issuer, client_id, client_secret) token cache with expiry.
#
# The previous implementation cached a single token in a module global with no
# key and no expiry, so a long-lived worker pod kept serving the first token it
# ever fetched. Once that token aged past the 5-minute Keycloak lifetime, every
# Lakekeeper / config-service call 401'd until the pod was restarted (observed
# on a 38h-old kb-worker). Keying by credentials also keeps distinct clients
# separate and picks up a rotated secret. Guarded by a lock because the worker
# runs activities on a thread pool (MAX_CONCURRENT_ACTIVITIES).
_lock = threading.Lock()
_token_cache: dict[tuple[str, str, str], tuple[str, float]] = {}


def get_access_token(
    keycloak_url: str,
    client_id: str,
    client_secret: str,
    use_cache: bool = True,
) -> str:
    """
    Get OAuth2 access token using service account credentials.

    Cached per (issuer, client) until shortly before the token expires; a fresh
    token is fetched automatically once the cached one is near expiry.

    Args:
        keycloak_url: Keycloak realm URL (e.g., http://keycloak:8080/realms/nemo)
        client_id: OAuth2 client ID
        client_secret: OAuth2 client secret
        use_cache: Whether to use the cached token

    Returns:
        Access token string
    """
    cache_key = (keycloak_url, client_id, client_secret)

    if use_cache:
        with _lock:
            entry = _token_cache.get(cache_key)
            if entry is not None and time.monotonic() < entry[1]:
                return entry[0]

    token_url = f"{keycloak_url}/protocol/openid-connect/token"

    params = {
        'grant_type': 'client_credentials',
        'client_id': client_id,
        'client_secret': client_secret,
        'scope': 'openid profile email',
    }

    try:
        response = requests.post(
            token_url,
            data=params,
            headers={'Content-Type': 'application/x-www-form-urlencoded'},
            timeout=10
        )
        response.raise_for_status()
        token_data = response.json()
        token = token_data['access_token']
        # Keycloak reports remaining lifetime in `expires_in` (seconds). Refresh
        # early via the skew; default conservatively when the field is absent.
        expires_in = int(token_data.get('expires_in', 60))
        ttl = max(expires_in - _EXPIRY_SKEW_SECONDS, 0)

        if use_cache:
            with _lock:
                now = time.monotonic()
                # Sweep aged-out entries (rotated secrets / one-off issuers that
                # are never looked up again) so the cache stays bounded to keys
                # with a live token instead of growing without limit.
                for stale in [k for k, (_t, exp) in _token_cache.items() if exp <= now]:
                    del _token_cache[stale]
                _token_cache[cache_key] = (token, now + ttl)

        logger.debug("Successfully obtained access token")
        return token
    except Exception as e:
        logger.error(f"Failed to get access token: {e}")
        raise


def get_authenticated_session(
    keycloak_url: str,
    client_id: str,
    client_secret: str
) -> requests.Session:
    """
    Create authenticated requests session with OAuth2 token.

    Args:
        keycloak_url: Keycloak realm URL
        client_id: OAuth2 client ID
        client_secret: OAuth2 client secret

    Returns:
        Configured requests.Session
    """
    session = requests.Session()
    token = get_access_token(keycloak_url, client_id, client_secret)
    session.headers.update({
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    })
    return session


def clear_token_cache() -> None:
    """Clear all cached tokens."""
    with _lock:
        _token_cache.clear()
