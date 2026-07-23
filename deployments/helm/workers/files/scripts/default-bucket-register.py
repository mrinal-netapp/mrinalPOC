#!/usr/bin/env python3
"""
Ensure the default bucket is accessible in S3gateway (VersityGW).
Run as a Helm hook (weight 4) so the bucket exists before default-setup (weight 10) runs.

VersityGW's POSIX backend auto-discovers mounted PVC directories as buckets.
This script first checks if the bucket already exists (HeadBucket / ListBuckets)
and only falls back to CreateBucket if needed. A CreateBucket 500 on an existing
mount-point directory is treated as success if HeadBucket confirms accessibility.
"""

import os
import sys
import time
import hmac
import hashlib
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("Error: requests required", flush=True)
    sys.exit(1)


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] {msg}", flush=True)


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def wait_for_url(url: str, name: str, max_wait_sec: int = 600, interval: float = 5.0) -> bool:
    """Poll URL until it returns 2xx or we exceed max_wait_sec.

    Default raised from 120s -> 600s so the FIRST RWX PVC provisioning (GKE
    Filestore Standard takes ~5-10 min for the initial share) completes
    before this Job attempt gives up. Overridable via S3GATEWAY_WAIT_SEC env
    var injected by the Helm chart (see defaultSetup.s3GatewayWaitSec).
    """
    deadline = time.monotonic() + max_wait_sec
    start = time.monotonic()
    while time.monotonic() < deadline:
        try:
            r = requests.get(url, timeout=10)
            if r.status_code < 400:
                elapsed = int(time.monotonic() - start)
                log(f"{name} is ready at {url} (after {elapsed}s)")
                return True
        except Exception as e:
            log(f"{name} not ready: {e}")
        time.sleep(interval)
    log(f"Timeout after {max_wait_sec}s waiting for {name}")
    return False


def s3_sigv4_sign(method: str, url: str, region: str, bucket: str, access_key: str, secret_key: str, body: bytes = b"") -> dict:
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
    canonical_request = f"{method}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    algorithm = "AWS4-HMAC-SHA256"
    credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
    string_to_sign = f"{algorithm}\n{amz_date}\n{credential_scope}\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"
    k_date = hmac.new(("AWS4" + secret_key).encode(), date_stamp.encode(), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode(), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    auth_header = f"{algorithm} Credential={access_key}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"
    return {"Host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date, "Authorization": auth_header}


def main() -> int:
    log("=== Default bucket register (CreateBucket only) ===")
    s3_url = env("S3GATEWAY_URL", "http://s3gateway:7070")
    bucket_name = env("DEFAULT_BUCKET_NAME")
    s3_region = env("S3_REGION", "us-east-1")
    s3_access_key = env("S3_ACCESS_KEY")
    s3_secret_key = env("S3_SECRET_KEY")
    try:
        wait_sec = int(env("S3GATEWAY_WAIT_SEC", "600"))
    except ValueError:
        wait_sec = 600
    if not bucket_name or not s3_access_key or not s3_secret_key:
        log("Error: DEFAULT_BUCKET_NAME, S3_ACCESS_KEY, S3_SECRET_KEY required")
        return 1
    log(f"Waiting for S3gateway at {s3_url} (timeout {wait_sec}s)...")
    if not wait_for_url(f"{s3_url}/health", "S3gateway", max_wait_sec=wait_sec):
        return 1
    url = f"{s3_url.rstrip('/')}/{bucket_name}"

    # Step 1: Check if bucket already exists via HeadBucket (GET /<bucket>)
    # The PVC mount may already expose the directory as a bucket in VersityGW.
    try:
        head_headers = s3_sigv4_sign("HEAD", url, s3_region, bucket_name, s3_access_key, s3_secret_key, body=b"")
        r = requests.head(url, headers=head_headers, timeout=15)
        if r.status_code == 200:
            log(f"Bucket {bucket_name} already exists (HeadBucket ok)")
            return 0
        log(f"HeadBucket returned {r.status_code}, will attempt CreateBucket")
    except Exception as e:
        log(f"HeadBucket check failed ({e}), will attempt CreateBucket")

    # Step 2: Try ListBuckets to see if VersityGW already knows about the bucket
    try:
        list_headers = s3_sigv4_sign("GET", s3_url.rstrip('/') + "/", s3_region, "", s3_access_key, s3_secret_key, body=b"")
        r = requests.get(s3_url.rstrip('/') + "/", headers=list_headers, timeout=15)
        if r.status_code == 200 and f"<Name>{bucket_name}</Name>" in r.text:
            log(f"Bucket {bucket_name} found in ListBuckets (ok)")
            return 0
    except Exception:
        pass

    # Step 3: Attempt CreateBucket (PUT /<bucket>)
    headers = s3_sigv4_sign("PUT", url, s3_region, bucket_name, s3_access_key, s3_secret_key, body=b"")
    try:
        r = requests.put(url, headers=headers, timeout=30)
        if r.status_code in (200, 201):
            log(f"Bucket {bucket_name} created")
            return 0
        if r.status_code == 409:
            log(f"Bucket {bucket_name} already exists (ok)")
            return 0
        # 500 can mean the directory already exists as a mount point — treat as success
        # if a subsequent HeadBucket confirms the bucket is accessible
        if r.status_code == 500:
            log(f"CreateBucket returned 500, checking if bucket is accessible anyway...")
            try:
                verify_headers = s3_sigv4_sign("HEAD", url, s3_region, bucket_name, s3_access_key, s3_secret_key, body=b"")
                vr = requests.head(url, headers=verify_headers, timeout=15)
                if vr.status_code == 200:
                    log(f"Bucket {bucket_name} is accessible despite CreateBucket 500 (ok - directory mount)")
                    return 0
            except Exception:
                pass
        log(f"CreateBucket failed: {r.status_code} {r.text[:200]}")
        return 1
    except Exception as e:
        log(f"CreateBucket error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
