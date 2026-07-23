"""Focused branch-coverage tests for mount preflight and adapter helpers."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from adapters.ontap_adapter import (
    OntapAdapter,
    _build_mount_preflight,
    _cidr_matches_rule,
    _export_policy_allows_client_cidrs,
    _parse_nfs_protocols,
    _suggested_nfs_vers_mount,
)
from adapters.base import ProviderAdapter


CFG = {"cluster_url": "https://ontap.example.com", "verify_tls": True}
CRED = {"username": "admin", "password": "p@ss"}


class TestMountPreflightMatrix:
    @pytest.mark.parametrize(
        "kwargs,expected_block",
        [
            (
                {
                    "svm_state": "stopped",
                    "junction_path": "/v",
                    "nfs_lif": {"address": "10.0.0.1"},
                    "nfs_svc": {"enabled": True, "state": "online"},
                    "nfs_protocols": {"v3": True},
                    "tcp": {"ok": True},
                    "export_policy_name": None,
                    "export_rules": [],
                    "client_cidrs": [],
                },
                "svm_not_running",
            ),
            (
                {
                    "svm_state": "running",
                    "junction_path": "",
                    "nfs_lif": {"address": "10.0.0.1"},
                    "nfs_svc": {"enabled": True, "state": "online"},
                    "nfs_protocols": {"v3": True},
                    "tcp": {"ok": True},
                    "export_policy_name": None,
                    "export_rules": [],
                    "client_cidrs": [],
                },
                "no_junction_path",
            ),
            (
                {
                    "svm_state": "running",
                    "junction_path": "/v",
                    "nfs_lif": None,
                    "nfs_svc": {"enabled": True, "state": "online"},
                    "nfs_protocols": {"v3": True},
                    "tcp": {"ok": True},
                    "export_policy_name": None,
                    "export_rules": [],
                    "client_cidrs": [],
                },
                "no_data_nfs_lif",
            ),
            (
                {
                    "svm_state": "running",
                    "junction_path": "/v",
                    "nfs_lif": {"address": "10.0.0.1"},
                    "nfs_svc": {"enabled": True, "state": "online"},
                    "nfs_protocols": {"v40": False, "v41": False, "v3": False},
                    "tcp": {"ok": True},
                    "export_policy_name": None,
                    "export_rules": [],
                    "client_cidrs": [],
                },
                "no_nfs_protocol_enabled",
            ),
            (
                {
                    "svm_state": "running",
                    "junction_path": "/v",
                    "nfs_lif": {"address": "10.0.0.1"},
                    "nfs_svc": {"enabled": True, "state": "online"},
                    "nfs_protocols": {"v3": True},
                    "tcp": {"ok": False},
                    "export_policy_name": None,
                    "export_rules": [],
                    "client_cidrs": [],
                },
                "tcp_2049_refused",
            ),
        ],
    )
    def test_blocking_reasons(self, kwargs, expected_block):
        mp = _build_mount_preflight(**kwargs)
        assert expected_block in mp["blocking"]
        assert mp["can_mount"] is False

    def test_nfs_service_unavailable_adds_warning(self):
        mp = _build_mount_preflight(
            svm_state="running",
            junction_path="/v",
            nfs_lif={"address": "10.0.0.1"},
            nfs_svc=None,
            nfs_protocols={"v3": True},
            tcp={"ok": True},
            export_policy_name="pol1",
            export_rules=[],
            client_cidrs=[],
        )
        assert "nfs_service_unavailable" in mp["warnings"]
        assert any(w.startswith("export_policy:") for w in mp["warnings"])


class TestNfsProtocolHelpers:
    def test_parse_nfs_protocols_defaults_when_missing(self):
        out = _parse_nfs_protocols(None)
        assert out["v3"] is True

    def test_suggested_nfs_vers_prefers_v3(self):
        assert _suggested_nfs_vers_mount({"v3": True, "v41": True}) == "vers=3"

    def test_suggested_nfs_vers_v41_when_no_v3(self):
        assert (
            _suggested_nfs_vers_mount({"v3": False, "v41": True, "v40": False})
            == "vers=4.1"
        )

    def test_suggested_nfs_vers_v40_fallback(self):
        assert (
            _suggested_nfs_vers_mount({"v3": False, "v41": False, "v40": True})
            == "vers=4.0"
        )


class TestCidrMatching:
    def test_ipv6_open_rule(self):
        assert _cidr_matches_rule("2001:db8::1/128", ["::/0"]) is True

    def test_overlap_networks(self):
        assert _cidr_matches_rule("10.1.0.0/24", ["10.0.0.0/8"]) is True

    def test_invalid_rule_skipped(self):
        assert (
            _export_policy_allows_client_cidrs(
                [{"clients_match": ["not-cidr", "10.0.0.0/8"]}],
                ["10.1.2.0/24"],
            )
            is True
        )

    def test_empty_client_cidrs_allowed(self):
        assert _export_policy_allows_client_cidrs([{"clients_match": []}], []) is True


class TestOntapValidationActions:
    def test_test_volume_mount_requires_volume(self):
        resp = OntapAdapter().execute(
            CFG, CRED, "testVolumeMount", {"svm_name": "svm1"}
        )
        assert resp.error.code == "VALIDATION_ERROR"

    def test_test_volume_mount_requires_svm(self):
        resp = OntapAdapter().execute(
            CFG,
            CRED,
            "testVolumeMount",
            {"volume_name": "vol1"},
        )
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.ontap_adapter._client_from_config")
    def test_list_snapshots_requires_svm(self, mock_factory):
        mock_factory.return_value = MagicMock()
        resp = OntapAdapter().execute(CFG, CRED, "listSnapshots", {})
        assert resp.error.code == "VALIDATION_ERROR"


class TestBaseAdapterResolve:
    def test_default_resolve_merges_selector(self):
        class _StubAdapter(ProviderAdapter):
            def execute(self, connector_config, credential, action, payload):
                return None  # type: ignore[return-value]

        merged = _StubAdapter().resolve(
            {"region": "us-east-1"},
            {},
            {"bucket": "my-bucket"},
        )
        assert merged["region"] == "us-east-1"
        assert merged["bucket"] == "my-bucket"
