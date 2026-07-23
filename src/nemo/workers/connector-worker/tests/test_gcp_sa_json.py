"""Tests for GCP service account JSON resolution from credential secrets."""
import json

from activities.gcp_sa_json import resolve_gcp_service_account_json

FAKE_SA = {
    "type": "service_account",
    "project_id": "my-proj",
    "private_key_id": "key1",
    "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    "client_email": "sa@my-proj.iam.gserviceaccount.com",
    "client_id": "123",
}


class TestResolveGcpServiceAccountJson:
    def test_prefers_service_account_json_field(self):
        raw = json.dumps(FAKE_SA)
        creds = {"service_account_json": raw, "type": "other"}
        assert resolve_gcp_service_account_json(creds) == raw

    def test_reassembles_legacy_flat_fields(self):
        creds = {k: str(v) for k, v in FAKE_SA.items()}
        resolved = resolve_gcp_service_account_json(creds)
        assert json.loads(resolved) == FAKE_SA

    def test_empty_when_missing_both_shapes(self):
        assert resolve_gcp_service_account_json({}) == ""
        assert resolve_gcp_service_account_json({"type": "service_account"}) == ""
