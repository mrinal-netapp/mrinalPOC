"""Resolve GCP service account key JSON from credential secret-data."""
import json
from typing import Dict

# Flat fields written by legacy UI code that split SA JSON into top-level keys.
_GCP_SA_FLAT_KEYS = (
    "type",
    "project_id",
    "private_key_id",
    "private_key",
    "client_email",
    "client_id",
    "auth_uri",
    "token_uri",
    "auth_provider_x509_cert_url",
    "client_x509_cert_url",
    "universe_domain",
)


def resolve_gcp_service_account_json(creds: Dict[str, str]) -> str:
    """Return SA key JSON from `service_account_json` or legacy flat secret fields."""
    sa_json = (creds.get("service_account_json") or "").strip()
    if sa_json:
        return sa_json

    if (creds.get("type") or "").strip() != "service_account":
        return ""

    info: Dict[str, str] = {}
    for key in _GCP_SA_FLAT_KEYS:
        val = creds.get(key)
        if isinstance(val, str) and val.strip():
            info[key] = val

    if info.get("private_key") and info.get("client_email"):
        return json.dumps(info, separators=(",", ":"))

    return ""
