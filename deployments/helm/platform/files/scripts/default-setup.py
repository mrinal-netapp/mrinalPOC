#!/usr/bin/env python3
"""
Default setup script for AgentStudio deployment.
1. Waits for S3gateway, obtains OIDC token, then waits for Lakekeeper Management API with auth (200 only).
2. Verifies the default bucket exists in S3gateway (does not create it).
3. Bootstraps Lakekeeper (accept EULA/terms) via Management API.
4. Creates the default warehouse in Lakekeeper using the default bucket and credentials.

Idempotent: safe to run multiple times (bootstrap "already done", warehouse 409 or 400 storage-profile-overlap treated as success).
Auth must succeed: 401 is not treated as success; the script ensures Lakekeeper OIDC is working.
"""

import os
import sys
import time
import hmac
import hashlib
import urllib.parse
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("Error: requests library required. Install with: pip install requests", flush=True)
    sys.exit(1)


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def log(msg: str, flush: bool = True) -> None:
    """Print a log line with optional timestamp; flush so output appears immediately in containers."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=flush)


def wait_for_url(url: str, name: str, max_wait_sec: int = 300, interval: float = 5.0) -> bool:
    """Poll URL until it returns 2xx or we timeout. Logs progress on each attempt."""
    start = time.monotonic()
    deadline = start + max_wait_sec
    attempt = 0
    max_attempts = max(1, int(max_wait_sec / interval))
    log(f"Waiting for {name} at {url} (max {max_wait_sec}s, check every {interval}s)...")
    while time.monotonic() < deadline:
        attempt += 1
        elapsed = int(time.monotonic() - start)
        try:
            r = requests.get(url, timeout=10)
            if r.status_code < 400:
                log(f"  {name} is ready at {url} (after {elapsed}s, attempt {attempt})")
                return True
            log(f"  [{elapsed}s] {name} returned HTTP {r.status_code} (attempt {attempt}/{max_attempts}). Retrying in {interval}s...")
        except Exception as e:
            log(f"  [{elapsed}s] {name} not ready: {e} (attempt {attempt}/{max_attempts}). Retrying in {interval}s...")
        time.sleep(interval)
    log(f"  Timeout after {max_wait_sec}s waiting for {name} at {url}")
    return False


def wait_for_lakekeeper_with_auth(
    base_url: str, token: str, max_wait_sec: int = 300, interval: float = 5.0
) -> bool:
    """Wait for Lakekeeper Management API to return 200 with the given Bearer token. 401 is not success."""
    url = f"{base_url.rstrip('/')}/management/v1/info"
    start = time.monotonic()
    deadline = start + max_wait_sec
    attempt = 0
    max_attempts = max(1, int(max_wait_sec / interval))
    log(f"Waiting for Lakekeeper Management API (auth required, 200 only) at {url}...")
    headers = {"Authorization": f"Bearer {token}"}
    while time.monotonic() < deadline:
        attempt += 1
        elapsed = int(time.monotonic() - start)
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                log(f"  Lakekeeper Management API is ready and auth succeeded (after {elapsed}s, attempt {attempt})")
                return True
            if r.status_code == 401:
                log(f"  [{elapsed}s] Lakekeeper returned 401 Unauthorized (attempt {attempt}/{max_attempts}). Auth not yet valid. Retrying in {interval}s...")
            else:
                log(f"  [{elapsed}s] Lakekeeper returned HTTP {r.status_code} (attempt {attempt}/{max_attempts}). Retrying in {interval}s...")
        except Exception as e:
            log(f"  [{elapsed}s] Lakekeeper not ready: {e} (attempt {attempt}/{max_attempts}). Retrying in {interval}s...")
        time.sleep(interval)
    log(f"  Timeout after {max_wait_sec}s; Lakekeeper Management API did not return 200 with auth")
    return False


def get_keycloak_token(issuer: str, client_id: str, client_secret: str) -> str:
    """Obtain OIDC access token using client_credentials grant."""
    token_url = issuer.rstrip("/") + "/protocol/openid-connect/token"
    data = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    r = requests.post(token_url, data=data, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def get_keycloak_token_with_retry(
    issuer: str, client_id: str, client_secret: str, max_attempts: int = 5, delay_sec: float = 15.0
) -> str:
    """Obtain OIDC token with retries to tolerate secret propagation after keycloak-setup."""
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            return get_keycloak_token(issuer, client_id, client_secret)
        except Exception as e:
            last_err = e
            if attempt < max_attempts:
                log(f"  Token attempt {attempt}/{max_attempts} failed: {e}. Retrying in {delay_sec}s...")
                time.sleep(delay_sec)
            else:
                raise last_err
    raise last_err


def s3_sigv4_sign(method: str, url: str, region: str, bucket: str,
                  access_key: str, secret_key: str, body: bytes = b"") -> dict:
    """Build AWS Signature Version 4 headers for S3-style request (path-style, single bucket)."""
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = parsed.netloc
    path = f"/{bucket}" if bucket else parsed.path or "/"
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()

    canonical_headers = f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = (
        f"{method}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    algorithm = "AWS4-HMAC-SHA256"
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = (
        f"{algorithm}\n{amz_date}\n{credential_scope}\n"
        f"{hashlib.sha256(canonical_request.encode()).hexdigest()}"
    )
    k_date = hmac.new(("AWS4" + secret_key).encode(), date_stamp.encode(), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode(), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    auth_header = (
        f"{algorithm} Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {
        "Host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Authorization": auth_header,
    }


def s3_bucket_exists(endpoint: str, bucket: str, region: str, access_key: str, secret_key: str) -> bool:
    """Check if bucket exists via S3 HeadBucket (path-style). Returns True if 200, False otherwise."""
    url = f"{endpoint.rstrip('/')}/{bucket}"
    log(f"  Checking if bucket {bucket} exists (HeadBucket)...")
    headers = s3_sigv4_sign("HEAD", url, region, bucket, access_key, secret_key, body=b"")
    try:
        r = requests.head(url, headers=headers, timeout=30)
        if r.status_code == 200:
            log(f"  Bucket {bucket} exists")
            return True
        if r.status_code == 404:
            log(f"  Bucket {bucket} does not exist (404). Create the default bucket before running default-setup.")
            return False
        log(f"  HeadBucket {bucket}: unexpected status {r.status_code} body={r.text[:200] if r.text else ''}")
        return False
    except Exception as e:
        log(f"  HeadBucket {bucket}: error {e}")
        return False


def lakekeeper_bootstrap(lakekeeper_url: str, token: str) -> bool:
    """POST /management/v1/bootstrap with accept-terms-of-use. Idempotent if already bootstrapped."""
    url = f"{lakekeeper_url.rstrip('/')}/management/v1/bootstrap"
    log("  Calling Lakekeeper bootstrap (accept EULA)...")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {"accept-terms-of-use": True, "is-operator": True}
    try:
        r = requests.post(url, json=body, headers=headers, timeout=30)
        if r.status_code == 204:
            log("  Lakekeeper bootstrap: done")
            return True
        if r.status_code in (400, 409) and ("already" in r.text.lower() or "bootstrap" in r.text.lower()):
            log("  Lakekeeper bootstrap: already bootstrapped (ok)")
            return True
        log(f"  Lakekeeper bootstrap: status {r.status_code} body={r.text[:300]}")
        return False
    except Exception as e:
        log(f"  Lakekeeper bootstrap: error {e}")
        return False


def lakekeeper_create_warehouse(
    lakekeeper_url: str,
    token: str,
    warehouse_name: str,
    bucket: str,
    region: str,
    endpoint: str,
    access_key: str,
    secret_key: str,
) -> bool:
    """POST /management/v1/warehouse. Idempotent: 201, 409 (already exists), or 400 CreateWarehouseStorageProfileOverlap when the overlapping warehouse has the same name = success."""
    url = f"{lakekeeper_url.rstrip('/')}/management/v1/warehouse"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {
        "warehouse-name": warehouse_name,
        "storage-profile": {
            "type": "s3",
            "bucket": bucket,
            "region": region,
            "endpoint": endpoint,
            "path-style-access": True,
            "flavor": "s3-compat",
            "sts-enabled": False,
        },
        "storage-credential": {
            "type": "s3",
            "credential-type": "access-key",
            "aws-access-key-id": access_key,
            "aws-secret-access-key": secret_key,
        },
    }
    log(f"  Calling Lakekeeper create warehouse '{warehouse_name}'...")
    try:
        r = requests.post(url, json=body, headers=headers, timeout=60)
        if r.status_code in (200, 201):
            log(f"  Lakekeeper warehouse {warehouse_name}: created")
            return True
        if r.status_code == 409:
            log(f"  Lakekeeper warehouse {warehouse_name}: already exists (ok)")
            return True
        # 400 CreateWarehouseStorageProfileOverlap = warehouse exists with overlapping storage profile (idempotent only if same name)
        if r.status_code == 400:
            try:
                err = r.json()
                code = (err.get("error") or {}).get("type") or ""
                msg = (err.get("error") or {}).get("message") or r.text or ""
                overlap_ok = "StorageProfileOverlap" in code or "overlaps with existing warehouse" in msg
                # Only treat as success when the overlapping warehouse is the one we intended to create
                same_warehouse = warehouse_name and warehouse_name in msg
                if overlap_ok and same_warehouse:
                    log(f"  Lakekeeper warehouse {warehouse_name}: already exists (storage profile overlap, ok)")
                    return True
            except Exception:
                pass
        log(f"  Lakekeeper warehouse: status {r.status_code} body={r.text[:300]}")
        return False
    except Exception as e:
        log(f"  Lakekeeper create warehouse: error {e}")
        return False


def main() -> int:
    script_start = time.monotonic()
    log("=== AgentStudio default-setup starting ===")
    log("Steps: wait S3gateway -> get OIDC token -> wait Lakekeeper Management API -> check bucket -> bootstrap -> create warehouse")

    issuer = env("KEYCLOAK_INTERNAL_ISSUER")
    client_id = env("LAKEKEEPER_CLIENT_ID")
    client_secret = env("LAKEKEEPER_CLIENT_SECRET")
    lakekeeper_url = env("LAKEKEEPER_URL", "http://lakekeeper:8181")
    s3_url = env("S3GATEWAY_URL", "http://s3gateway:7070")
    bucket_name = env("DEFAULT_BUCKET_NAME")
    # Warehouse name: use deployment name (e.g. nemo), not bucket name (e.g. default-nemo)
    warehouse_name = env("DEFAULT_WAREHOUSE_NAME")
    if not warehouse_name and bucket_name and bucket_name.startswith("default-"):
        warehouse_name = bucket_name[len("default-"):]
    warehouse_name = warehouse_name or bucket_name
    s3_region = env("S3_REGION", "us-east-1")
    s3_access_key = env("S3_ACCESS_KEY")
    s3_secret_key = env("S3_SECRET_KEY")
    try:
        s3_wait_sec = int(env("S3GATEWAY_WAIT_SEC", "600"))
    except ValueError:
        s3_wait_sec = 600
    try:
        lk_wait_sec = int(env("LAKEKEEPER_WAIT_SEC", "300"))
    except ValueError:
        lk_wait_sec = 300

    if not bucket_name:
        log("Error: DEFAULT_BUCKET_NAME is required")
        return 1
    if not issuer or not client_id or not client_secret:
        log("Error: KEYCLOAK_INTERNAL_ISSUER, LAKEKEEPER_CLIENT_ID, LAKEKEEPER_CLIENT_SECRET required")
        return 1
    if not s3_access_key or not s3_secret_key:
        log("Error: S3_ACCESS_KEY and S3_SECRET_KEY (from s3gateway credentials secret) required")
        return 1

    log(f"Step 1/6: Waiting for S3gateway (timeout {s3_wait_sec}s)...")
    if not wait_for_url(f"{s3_url}/health", "S3gateway", max_wait_sec=s3_wait_sec):
        return 1

    log("Step 2/6: Obtaining OIDC token from Keycloak...")
    # Brief delay so keycloak-oidc-secrets propagation is visible after keycloak-setup job
    time.sleep(5)
    try:
        token = get_keycloak_token_with_retry(issuer, client_id, client_secret, max_attempts=5, delay_sec=15.0)
        log("  Token obtained successfully")
    except Exception as e:
        log(f"Error getting token: {e}")
        log("  Check: (1) keycloak-setup job completed and updated keycloak-oidc-secrets, (2) secret has non-placeholder lakekeeper-client-secret")
        return 1

    log(f"Step 3/6: Waiting for Lakekeeper Management API (timeout {lk_wait_sec}s, auth must succeed, 200 only)...")
    if not wait_for_lakekeeper_with_auth(lakekeeper_url, token, max_wait_sec=lk_wait_sec):
        return 1

    log("Step 4/6: Checking default bucket exists in S3gateway...")
    if not s3_bucket_exists(s3_url, bucket_name, s3_region, s3_access_key, s3_secret_key):
        log(f"Error: Default bucket '{bucket_name}' must exist. Ensure the default bucket PVC is created and S3gateway has registered the bucket.")
        return 1

    log("Step 5/6: Bootstrapping Lakekeeper (accept EULA)...")
    if not lakekeeper_bootstrap(lakekeeper_url, token):
        return 1

    log("Step 6/6: Creating default warehouse in Lakekeeper...")
    if not lakekeeper_create_warehouse(
        lakekeeper_url, token, warehouse_name,
        bucket_name, s3_region, s3_url,
        s3_access_key, s3_secret_key,
    ):
        return 1

    elapsed = int(time.monotonic() - script_start)
    log(f"=== Default setup completed successfully in {elapsed}s ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
