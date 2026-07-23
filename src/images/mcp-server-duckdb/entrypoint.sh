#!/bin/bash
set -e

export HOME=/tmp

python3 -c "
import urllib.request, time, os, socket

def wait(url, name, timeout=120, interval=5):
    print(f'[entrypoint] Waiting for {name} at {url} (max {timeout}s)...', flush=True)
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        elapsed = int(time.monotonic() + timeout - deadline)
        try:
            resp = urllib.request.urlopen(url, timeout=5)
            print(f'[entrypoint] {name} is ready (HTTP {resp.status}, after {elapsed}s)', flush=True)
            return
        except urllib.error.HTTPError as e:
            # Server responded -- it's up, just returned an error status
            print(f'[entrypoint] {name} responded HTTP {e.code} (attempt {attempt}, {elapsed}s) -- treating as ready', flush=True)
            return
        except urllib.error.URLError as e:
            reason = str(e.reason) if hasattr(e, 'reason') else str(e)
            print(f'[entrypoint] {name} not ready: {reason} (attempt {attempt}, {elapsed}s)', flush=True)
        except Exception as e:
            print(f'[entrypoint] {name} error: {type(e).__name__}: {e} (attempt {attempt}, {elapsed}s)', flush=True)
        time.sleep(interval)
    print(f'[entrypoint] WARNING: {name} not ready after {timeout}s, proceeding anyway', flush=True)

# DNS check
lk_host = 'lakekeeper'
try:
    ip = socket.gethostbyname(lk_host)
    print(f'[entrypoint] DNS: {lk_host} -> {ip}', flush=True)
except Exception as e:
    print(f'[entrypoint] DNS: {lk_host} FAILED: {e}', flush=True)

kc_host = os.environ.get('KEYCLOAK_HOST', 'keycloak.agentstudio-identity.svc.cluster.local')
try:
    ip = socket.gethostbyname(kc_host)
    print(f'[entrypoint] DNS: {kc_host} -> {ip}', flush=True)
except Exception as e:
    print(f'[entrypoint] DNS: {kc_host} FAILED: {e}', flush=True)

lk = os.environ.get('LAKEKEEPER_CATALOG_URL', 'http://lakekeeper:8181/catalog')
kc = os.environ.get('KEYCLOAK_TOKEN_URL', '')
print(f'[entrypoint] LAKEKEEPER_CATALOG_URL={lk}', flush=True)
print(f'[entrypoint] KEYCLOAK_TOKEN_URL={kc}', flush=True)

wait(lk + '/v1/config', 'Lakekeeper', 180, 5)
if kc:
    # Probe the realm base URL (GET-friendly) rather than the token endpoint (POST-only)
    realm_url = kc.rsplit('/protocol/', 1)[0] if '/protocol/' in kc else kc.rsplit('/', 1)[0]
    print(f'[entrypoint] Keycloak probe URL: {realm_url}', flush=True)
    wait(realm_url, 'Keycloak', 120, 5)

print('[entrypoint] Dependency checks complete.', flush=True)

# Test OAuth2 client_credentials token fetch before DuckDB tries it
if kc:
    client_id = os.environ.get('LAKEKEEPER_CLIENT_ID', '')
    client_secret = os.environ.get('LAKEKEEPER_CLIENT_SECRET', '')
    scope = os.environ.get('OAUTH2_SCOPE', 'openid profile email')
    print(f'[entrypoint] Testing OAuth2 token fetch: client_id={client_id}, scope={scope or \"(default)\"} ', flush=True)
    try:
        import urllib.parse
        params = {
            'grant_type': 'client_credentials',
            'client_id': client_id,
            'client_secret': client_secret,
        }
        if scope:
            params['scope'] = scope
        data = urllib.parse.urlencode(params).encode()
        req = urllib.request.Request(kc, data=data, headers={'Content-Type': 'application/x-www-form-urlencoded'})
        resp = urllib.request.urlopen(req, timeout=10)
        body = resp.read().decode()
        print(f'[entrypoint] OAuth2 token fetch OK (HTTP {resp.status}, body length={len(body)})', flush=True)
    except urllib.error.HTTPError as e:
        body = e.read().decode() if hasattr(e, 'read') else ''
        print(f'[entrypoint] OAuth2 token fetch FAILED: HTTP {e.code}', flush=True)
        print(f'[entrypoint] Response body: {body}', flush=True)
    except Exception as e:
        print(f'[entrypoint] OAuth2 token fetch ERROR: {type(e).__name__}: {e}', flush=True)

print('[entrypoint] Starting duckdb-iceberg-mcp server...', flush=True)
"

# server.py handles DuckDB init, SECRET creation, ATTACH, and automatic
# OAuth2 token refresh — no init.sql needed.
echo "[entrypoint] Starting duckdb-iceberg-mcp on :8000..."

exec python3 /app/server.py \
  --host 0.0.0.0 \
  --port 8000 \
  --transport streamable-http
