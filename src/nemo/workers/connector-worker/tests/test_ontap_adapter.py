"""Unit tests for the ONTAP adapter."""

from __future__ import annotations

from unittest.mock import MagicMock, patch


from adapters.ontap_adapter import OntapAdapter
from ontap_common import OntapAuthError, OntapTLSVerifyError


CFG = {"cluster_url": "https://ontap.example.com", "verify_tls": True}
CRED = {"username": "admin", "password": "p@ss"}


def _adapter() -> OntapAdapter:
    return OntapAdapter()


def _make_paginated_page(data: dict):
    page = MagicMock()
    page.records = data.get("records", [])
    page.truncated = data.get("truncated", False)
    page.total_records = data.get("total_records")
    return page


def _patch_client(*, get=None, paginated=None, paginated_sequence=None):
    """Build a context-manager mock that mimics OntapClient."""
    client = MagicMock()
    client.__enter__.return_value = client
    client.__exit__.return_value = False
    if get is not None:
        client.get.return_value = get
    if paginated_sequence is not None:
        client.get_paginated.side_effect = [
            _make_paginated_page(p) for p in paginated_sequence
        ]
    elif paginated is not None:
        client.get_paginated.return_value = _make_paginated_page(paginated)
    return client


class TestDispatcher:
    def test_unsupported_action_returns_error(self):
        resp = _adapter().execute(CFG, CRED, "doesNotExist", {})
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"

    def test_validation_error_when_cluster_url_missing(self):
        resp = _adapter().execute({}, CRED, "testConnection", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"


class TestListMetricCategories:
    """Unified ONTAP connector serves listMetricCategories synthetically.

    No live ONTAP REST call should fire — it's a fixed leaf set that the
    workflow-engine's metrics dispatch keys on.
    """

    def test_returns_four_metric_category_leaves(self):
        resp = _adapter().execute(CFG, CRED, "listMetricCategories", {})
        assert resp.error is None
        types = {n.type for n in resp.nodes}
        assert types == {"metric_category"}
        cats = sorted([(n.resource or {}).get("category") for n in resp.nodes])
        assert cats == [
            "aggregate_metrics",
            "quota_metrics",
            "volume_metrics",
        ]
        for n in resp.nodes:
            assert n.children_hint == "leaf"


class TestTestConnection:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_returns_cluster_node(self, mock_factory):
        mock_factory.return_value = _patch_client(
            get={"name": "cluster1", "version": {"full": "9.13.1"}},
        )
        resp = _adapter().execute(CFG, CRED, "testConnection", {})
        assert resp.error is None
        assert len(resp.nodes) == 1
        node = resp.nodes[0]
        assert node.label == "cluster1"
        assert node.type == "service"
        assert node.metadata["version"] == "9.13.1"

    @patch("adapters.ontap_adapter._client_from_config")
    def test_tls_error_maps_to_envelope(self, mock_factory):
        client = _patch_client()
        client.get.side_effect = OntapTLSVerifyError()
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "testConnection", {})
        assert resp.error is not None
        assert resp.error.code == "TLS_VERIFY_FAILED"

    @patch("adapters.ontap_adapter._client_from_config")
    def test_auth_error_maps_to_unauthorized(self, mock_factory):
        client = _patch_client()
        client.get.side_effect = OntapAuthError("bad creds", status=401)
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "testConnection", {})
        assert resp.error is not None
        assert resp.error.code == "UNAUTHORIZED"


class TestListPathAlias:
    """GUI / legacy explorer paths may call listPath at root; ONTAP maps it to listServices."""

    def test_list_path_matches_list_services(self):
        a = _adapter()
        r1 = a.execute(CFG, CRED, "listPath", {})
        r2 = a.execute(CFG, CRED, "listServices", {})
        assert r1.error is None and r2.error is None
        assert [n.id for n in r1.nodes] == [n.id for n in r2.nodes]


class TestListServices:
    def test_root_shows_svm_and_metrics_entries(self):
        # ONTAP root surfaces both the Storage VMs branch and the
        # synthetic Performance Metrics branch (see OntapAdapter
        # ._list_services). Order matters here: SVMs first, metrics last.
        resp = _adapter().execute(CFG, CRED, "listServices", {})
        assert resp.error is None
        labels = [n.label for n in resp.nodes]
        assert labels == ["Storage VMs (SVMs)", "Performance Metrics"]

    def test_default_svm_collapses_svm_branch_to_single_node(self):
        # With default_svm set the SVMs branch collapses to a single SVM
        # node, but the Performance Metrics branch is independent of
        # default_svm and is always present. So the response carries the
        # collapsed SVM node plus the metrics node = 2 total.
        cfg = {**CFG, "default_svm": "svm1"}
        resp = _adapter().execute(cfg, CRED, "listServices", {})
        assert resp.error is None
        assert len(resp.nodes) == 2
        kinds = [n.kind for n in resp.nodes]
        assert kinds.count("svm") == 1
        assert kinds.count("metrics") == 1


class TestListSvms:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_returns_svm_nodes(self, mock_factory):
        mock_factory.return_value = _patch_client(
            paginated={
                "records": [
                    {
                        "uuid": "u1",
                        "name": "svm1",
                        "state": "running",
                        "ipspace": {"name": "Default"},
                        "language": "c.utf_8",
                    },
                ],
            }
        )
        resp = _adapter().execute(CFG, CRED, "listSvms", {})
        assert resp.error is None
        assert len(resp.nodes) == 1
        n = resp.nodes[0]
        assert n.label == "svm1"
        assert n.resource["svm_uuid"] == "u1"
        assert n.metadata["state"] == "running"

    @patch("adapters.ontap_adapter._client_from_config")
    def test_truncation_marker_on_last_record(self, mock_factory):
        mock_factory.return_value = _patch_client(
            paginated={
                "records": [
                    {"uuid": "u1", "name": "svm1"},
                    {"uuid": "u2", "name": "svm2"},
                ],
                "truncated": True,
            }
        )
        resp = _adapter().execute(CFG, CRED, "listSvms", {})
        assert resp.nodes[-1].metadata["truncated"] is True
        assert "truncated" not in (resp.nodes[0].metadata or {})


class TestListVolumes:
    def test_requires_svm_or_default(self):
        resp = _adapter().execute(CFG, CRED, "listVolumes", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.ontap_adapter._fetch_export_policy_rules", return_value=[])
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_uses_default_svm(
        self, mock_factory, mock_lif, mock_nfs, mock_tcp, _mock_ex
    ):
        mock_lif.return_value = {
            "address": "10.0.0.2",
            "lif_name": "lif1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {
            "ok": True,
            "error": None,
            "probe_origin": "connector_worker_pod",
        }
        client = _patch_client(
            paginated_sequence=[
                {
                    "records": [
                        {
                            "uuid": "v1",
                            "name": "vol1",
                            "size": 1024,
                            "space": {"used": 100, "available": 924},
                            "svm": {"uuid": "su1", "name": "svm1", "state": "running"},
                            "nas": {
                                "path": "/vol1",
                                "export_policy": {"name": "default"},
                            },
                        },
                    ],
                },
            ]
        )
        mock_factory.return_value = client
        cfg = {**CFG, "default_svm": "svm1"}
        resp = _adapter().execute(cfg, CRED, "listVolumes", {})
        assert resp.error is None
        assert client.get_paginated.call_count == 1
        vol_call = client.get_paginated.call_args_list[0]
        assert vol_call.args[0] == "/api/storage/volumes"
        assert vol_call.kwargs["params"]["svm.name"] == "svm1"
        mp = resp.nodes[0].metadata["mount_preflight"]
        assert mp["can_mount"] is True

    @patch("adapters.ontap_adapter._fetch_export_policy_rules", return_value=[])
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_uses_svm_uuid_from_payload(
        self, mock_factory, mock_lif, mock_nfs, mock_tcp, _mock_ex
    ):
        mock_lif.return_value = {
            "address": "10.0.0.2",
            "lif_name": "lif1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {
            "ok": True,
            "error": None,
            "probe_origin": "connector_worker_pod",
        }
        client = _patch_client(
            paginated_sequence=[
                {"records": []},
            ]
        )
        mock_factory.return_value = client
        _adapter().execute(CFG, CRED, "listVolumes", {"svm_uuid": "U-9"})
        vol_call = client.get_paginated.call_args_list[0]
        assert vol_call.kwargs["params"]["svm.uuid"] == "U-9"

    @patch("adapters.ontap_adapter._fetch_export_policy_rules", return_value=[])
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_includes_nfs_data_lif_in_volume_metadata(
        self, mock_factory, mock_lif, mock_nfs, mock_tcp, _mock_ex
    ):
        mock_lif.return_value = {
            "address": "10.0.0.55",
            "lif_name": "data1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {
            "ok": True,
            "error": None,
            "probe_origin": "connector_worker_pod",
        }
        client = _patch_client(
            paginated_sequence=[
                {
                    "records": [
                        {
                            "uuid": "v1",
                            "name": "vol1",
                            "svm": {"uuid": "su1", "name": "svm1", "state": "running"},
                            "nas": {
                                "path": "/vol1",
                                "export_policy": {"name": "default"},
                            },
                        },
                    ],
                },
            ]
        )
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "listVolumes", {"svm_name": "svm1"})
        assert resp.error is None
        assert resp.nodes[0].metadata["nfs_data_lif"] == "10.0.0.55"
        assert resp.nodes[0].metadata["nfs_data_lif_name"] == "data1"

    @patch("adapters.ontap_adapter._fetch_export_policy_rules", return_value=[])
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_tcp_refused_blocks_mount(
        self, mock_factory, mock_lif, mock_nfs, mock_tcp, _mock_ex
    ):
        mock_lif.return_value = {
            "address": "10.0.0.55",
            "lif_name": "data1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {
            "ok": False,
            "error": "Connection refused",
            "probe_origin": "connector_worker_pod",
        }
        client = _patch_client(
            paginated_sequence=[
                {
                    "records": [
                        {
                            "uuid": "v1",
                            "name": "vol1",
                            "svm": {"uuid": "su1", "name": "svm1", "state": "running"},
                            "nas": {
                                "path": "/vol1",
                                "export_policy": {"name": "default"},
                            },
                        },
                    ],
                },
            ]
        )
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "listVolumes", {"svm_name": "svm1"})
        mp = resp.nodes[0].metadata["mount_preflight"]
        assert mp["can_mount"] is False
        assert "tcp_2049_refused" in mp["blocking"]

    @patch("adapters.ontap_adapter._fetch_export_policy_rules", return_value=[])
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_no_junction_blocks(
        self, mock_factory, mock_lif, mock_nfs, mock_tcp, _mock_ex
    ):
        mock_lif.return_value = {
            "address": "10.0.0.55",
            "lif_name": "data1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {
            "ok": True,
            "error": None,
            "probe_origin": "connector_worker_pod",
        }
        client = _patch_client(
            paginated_sequence=[
                {
                    "records": [
                        {
                            "uuid": "v1",
                            "name": "vol1",
                            "svm": {"uuid": "su1", "name": "svm1", "state": "running"},
                            "nas": {},
                        },
                    ],
                },
            ]
        )
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "listVolumes", {"svm_name": "svm1"})
        mp = resp.nodes[0].metadata["mount_preflight"]
        assert mp["can_mount"] is False
        assert "no_junction_path" in mp["blocking"]


class TestListLuns:
    def test_requires_svm(self):
        resp = _adapter().execute(CFG, CRED, "listLuns", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.ontap_adapter._client_from_config")
    def test_returns_lun_nodes(self, mock_factory):
        mock_factory.return_value = _patch_client(
            paginated={
                "records": [
                    {
                        "uuid": "l1",
                        "name": "lun1",
                        "space": {"size": 5000},
                        "status": {"mapped": True, "state": "online"},
                        "os_type": "linux",
                    },
                ]
            }
        )
        resp = _adapter().execute(CFG, CRED, "listLuns", {"svm_name": "svm1"})
        assert resp.error is None
        assert resp.nodes[0].metadata["mapped"] is True


class TestListSnapshots:
    def test_requires_volume_uuid(self):
        resp = _adapter().execute(CFG, CRED, "listSnapshots", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.ontap_adapter._client_from_config")
    def test_returns_snapshots(self, mock_factory):
        client = _patch_client(
            paginated={
                "records": [
                    {
                        "uuid": "s1",
                        "name": "snap1",
                        "create_time": "2026-01-01T00:00:00Z",
                    },
                ]
            }
        )
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "listSnapshots", {"volume_uuid": "v1"})
        assert resp.error is None
        client.get_paginated.assert_called_once()
        path = client.get_paginated.call_args.args[0]
        assert path == "/api/storage/volumes/v1/snapshots"


class TestListAggregates:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_returns_aggregate_nodes(self, mock_factory):
        mock_factory.return_value = _patch_client(
            paginated={
                "records": [
                    {
                        "uuid": "a1",
                        "name": "aggr1",
                        "state": "online",
                        "block_storage": {"primary": {"raid_type": "raid_dp"}},
                        "space": {
                            "block_storage": {"size": 100, "used": 10, "available": 90}
                        },
                        "node": {"name": "node-1"},
                    },
                ]
            }
        )
        resp = _adapter().execute(CFG, CRED, "listAggregates", {})
        assert resp.error is None
        assert resp.nodes[0].metadata["raid_type"] == "raid_dp"


class TestMountPreflightHelpers:
    def test_cidr_matches_open_rule(self):
        from adapters.ontap_adapter import _cidr_matches_rule

        assert _cidr_matches_rule("10.0.0.5/32", ["0.0.0.0/0"]) is True

    def test_cidr_matches_host_address(self):
        from adapters.ontap_adapter import _cidr_matches_rule

        assert _cidr_matches_rule("10.0.0.0/24", ["10.0.0.5"]) is True

    def test_cidr_invalid_client_returns_false(self):
        from adapters.ontap_adapter import _cidr_matches_rule

        assert _cidr_matches_rule("not-a-cidr", ["0.0.0.0/0"]) is False

    def test_export_policy_blocks_missing_client(self):
        from adapters.ontap_adapter import _export_policy_allows_client_cidrs

        rules = [{"clients_match": ["192.168.1.0/24"]}]
        assert _export_policy_allows_client_cidrs(rules, ["10.0.0.0/24"]) is False

    def test_export_policy_allows_matching_client(self):
        from adapters.ontap_adapter import _export_policy_allows_client_cidrs

        rules = [{"clients_match": ["10.0.0.0/8"]}]
        assert _export_policy_allows_client_cidrs(rules, ["10.1.2.3/32"]) is True

    def test_build_mount_preflight_nfs_disabled(self):
        from adapters.ontap_adapter import _build_mount_preflight

        mp = _build_mount_preflight(
            svm_state="running",
            junction_path="/vol1",
            nfs_lif={"address": "10.0.0.1"},
            nfs_svc={"enabled": False, "state": "online"},
            nfs_protocols={"nfs3": True},
            tcp={"ok": True},
            export_policy_name="default",
            export_rules=[],
            client_cidrs=[],
        )
        assert mp["can_mount"] is False
        assert "nfs_service_disabled" in mp["blocking"]

    def test_build_mount_preflight_export_policy_blocks(self):
        from adapters.ontap_adapter import _build_mount_preflight

        mp = _build_mount_preflight(
            svm_state="running",
            junction_path="/vol1",
            nfs_lif={"address": "10.0.0.1"},
            nfs_svc={"enabled": True, "state": "online"},
            nfs_protocols={"nfs3": True},
            tcp={"ok": True},
            export_policy_name="strict",
            export_rules=[{"clients_match": ["172.16.0.0/12"]}],
            client_cidrs=["10.0.0.0/24"],
        )
        assert mp["can_mount"] is False
        assert "export_policy_blocks_node_cidr" in mp["blocking"]


class TestTestVolumeMount:
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._fetch_export_policy_rules")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_by_volume_uuid(
        self,
        mock_factory,
        mock_lif,
        mock_nfs,
        mock_export,
        mock_tcp,
    ):
        mock_factory.return_value = _patch_client(
            get={
                "uuid": "vol-uuid-1",
                "name": "vol1",
                "state": "online",
                "svm": {"uuid": "svm-1", "name": "svm1", "state": "running"},
                "nas": {"path": "/vol1", "export_policy": {"name": "default"}},
                "space": {},
                "aggregates": [],
            }
        )
        mock_lif.return_value = {"address": "10.0.0.50", "lif_state": "up"}
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_export.return_value = [{"clients_match": ["0.0.0.0/0"]}]
        mock_tcp.return_value = {"ok": True}

        resp = _adapter().execute(
            CFG,
            CRED,
            "testVolumeMount",
            {"volume_uuid": "vol-uuid-1", "svm_uuid": "svm-1"},
        )
        assert resp.error is None
        assert resp.nodes[0].metadata["mount_preflight"]["can_mount"] is True

    @patch("adapters.ontap_adapter._client_from_config")
    def test_volume_not_found_by_uuid(self, mock_factory):
        from ontap_common import OntapError

        client = _patch_client()
        client.get.side_effect = OntapError("missing", status=404)
        mock_factory.return_value = client

        resp = _adapter().execute(
            CFG,
            CRED,
            "testVolumeMount",
            {"volume_uuid": "missing", "svm_uuid": "svm-1"},
        )
        assert resp.error is not None
        assert resp.error.code == "NOT_FOUND"

    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._fetch_export_policy_rules")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_by_volume_name(
        self,
        mock_factory,
        mock_lif,
        mock_nfs,
        mock_export,
        mock_tcp,
    ):
        mock_lif.return_value = {"address": "10.0.0.50", "lif_state": "up"}
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_export.return_value = [{"clients_match": ["0.0.0.0/0"]}]
        mock_tcp.return_value = {"ok": True}
        client = _patch_client(
            paginated={
                "records": [
                    {
                        "uuid": "vol-uuid-1",
                        "name": "vol1",
                        "state": "online",
                        "svm": {"uuid": "svm-1", "name": "svm1", "state": "running"},
                        "nas": {"path": "/vol1", "export_policy": {"name": "default"}},
                        "space": {},
                        "aggregates": [],
                    }
                ]
            },
        )
        mock_factory.return_value = client

        resp = _adapter().execute(
            CFG,
            CRED,
            "testVolumeMount",
            {"volume_name": "vol1", "svm_name": "svm1"},
        )
        assert resp.error is None
        assert resp.nodes[0].metadata["mount_preflight"]["can_mount"] is True


class TestOntapHelperBranches:
    def test_fetch_export_policy_rules_parses_client_strings(self):
        from adapters.ontap_adapter import _fetch_export_policy_rules

        client = MagicMock()
        page = MagicMock()
        page.records = [
            {
                "rules": [
                    {
                        "clients": ["10.0.0.0/8", {"match": "172.16.0.0/12"}],
                        "protocols": ["nfs3"],
                    },
                ],
            }
        ]
        client.get_paginated.return_value = page
        rules = _fetch_export_policy_rules(client, "svm-u", "default")
        assert rules[0]["clients_match"] == ["10.0.0.0/8", "172.16.0.0/12"]

    def test_fetch_export_policy_rules_returns_empty_on_error(self):
        from adapters.ontap_adapter import _fetch_export_policy_rules
        from ontap_common import OntapError

        client = MagicMock()
        client.get_paginated.side_effect = OntapError("fail")
        assert _fetch_export_policy_rules(client, "svm-u", "default") == []

    def test_fetch_export_policy_rules_requires_policy_and_svm(self):
        from adapters.ontap_adapter import _fetch_export_policy_rules

        client = MagicMock()
        assert _fetch_export_policy_rules(client, "", "default") == []
        assert _fetch_export_policy_rules(client, "svm-u", "") == []


class TestListLunsValidation:
    def test_requires_svm_when_not_in_config(self):
        resp = _adapter().execute(CFG, CRED, "listLuns", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"


class TestResolveBestMount:
    @patch("adapters.ontap_adapter.OntapAdapter._test_volume_mount")
    def test_delegates_to_test_volume_mount(self, mock_test):
        mock_test.return_value = MagicMock(
            error=None,
            nodes=[
                MagicMock(
                    id="ontap:vol/v1",
                    label="vol1",
                    resource={"volume_uuid": "v1"},
                    metadata={
                        "junction_path": "/vol1",
                        "nfs_data_lif": "10.0.0.50",
                        "suggested_nfs_vers": "vers=3",
                        "mount_preflight": {"can_mount": True},
                        "nfs_protocols": {"nfs3": True},
                    },
                )
            ],
        )
        resp = _adapter().execute(
            CFG,
            CRED,
            "resolveBestMountForVolume",
            {"volume_uuid": "v1", "svm_uuid": "svm-1"},
        )
        assert resp.error is None
        assert resp.nodes[0].kind == "MountResolution"
        assert "10.0.0.50:/vol1" in resp.nodes[0].resource["endpoint"]


class TestNetworkProbeActions:
    @patch("adapters.ontap_adapter._tcp_probe")
    def test_test_network_interface_reachability(self, mock_tcp):
        mock_tcp.return_value = {"ok": False, "error": "refused"}
        resp = _adapter().execute(
            CFG,
            CRED,
            "testNetworkInterfaceReachability",
            {"address": "10.0.0.99"},
        )
        assert resp.error is None
        assert resp.nodes[0].metadata["tcp_2049"]["ok"] is False

    def test_test_network_requires_address(self):
        resp = _adapter().execute(CFG, CRED, "testNetworkInterfaceReachability", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.ontap_adapter.OntapAdapter._list_network_interfaces")
    def test_list_svm_interfaces_delegates(self, mock_list):
        mock_list.return_value = MagicMock(error=None, nodes=[])
        resp = _adapter().execute(CFG, CRED, "listSvmInterfaces", {"svm_uuid": "s1"})
        assert resp.error is None
        mock_list.assert_called_once()

    @patch("adapters.ontap_adapter._fetch_export_policy_rules")
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_export_policy_blocks_client_cidr(
        self,
        mock_factory,
        mock_lif,
        mock_nfs,
        mock_tcp,
        mock_export,
    ):
        mock_lif.return_value = {
            "address": "10.0.0.55",
            "lif_name": "data1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "online",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {"ok": True}
        mock_export.return_value = [{"clients_match": ["172.16.0.0/12"]}]
        client = _patch_client(
            paginated_sequence=[
                {
                    "records": [
                        {
                            "uuid": "v1",
                            "name": "vol1",
                            "svm": {"uuid": "su1", "name": "svm1", "state": "running"},
                            "nas": {
                                "path": "/vol1",
                                "export_policy": {"name": "strict"},
                            },
                        }
                    ],
                }
            ],
        )
        mock_factory.return_value = client
        cfg = {**CFG, "client_cidrs": ["10.0.0.0/24"]}
        resp = _adapter().execute(cfg, CRED, "listVolumes", {"svm_name": "svm1"})
        mp = resp.nodes[0].metadata["mount_preflight"]
        assert mp["can_mount"] is False
        assert "export_policy_blocks_node_cidr" in mp["blocking"]

    @patch("adapters.ontap_adapter._fetch_export_policy_rules", return_value=[])
    @patch("adapters.ontap_adapter._tcp_probe")
    @patch("adapters.ontap_adapter._svm_nfs_service")
    @patch("adapters.ontap_adapter._nfs_data_lif_for_svm")
    @patch("adapters.ontap_adapter._client_from_config")
    def test_nfs_service_offline_blocks_mount(
        self,
        mock_factory,
        mock_lif,
        mock_nfs,
        mock_tcp,
        _mock_ex,
    ):
        mock_lif.return_value = {
            "address": "10.0.0.55",
            "lif_name": "data1",
            "lif_state": "up",
        }
        mock_nfs.return_value = {
            "enabled": True,
            "state": "offline",
            "protocol": {"v3_enabled": True},
        }
        mock_tcp.return_value = {"ok": True}
        client = _patch_client(
            paginated_sequence=[
                {
                    "records": [
                        {
                            "uuid": "v1",
                            "name": "vol1",
                            "svm": {"uuid": "su1", "name": "svm1", "state": "running"},
                            "nas": {"path": "/vol1"},
                        }
                    ],
                }
            ],
        )
        mock_factory.return_value = client
        resp = _adapter().execute(CFG, CRED, "listVolumes", {"svm_name": "svm1"})
        mp = resp.nodes[0].metadata["mount_preflight"]
        assert "nfs_service_offline" in mp["blocking"]

    @patch("adapters.ontap_adapter._client_from_config")
    def test_enrich_svm_metadata_captures_internal_error(self, mock_factory):
        client = MagicMock()
        client.__enter__.side_effect = RuntimeError("enrich failed")
        client.__exit__.return_value = False
        mock_factory.return_value = client
        meta = _adapter()._enrich_svm_node_metadata(
            CFG,
            CRED,
            {"uuid": "u1", "name": "svm1", "state": "running"},
        )
        assert "svm_enrich_error" in meta


class TestListNetworkInterfaces:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_returns_lif_nodes(self, mock_factory):
        mock_factory.return_value = _patch_client(
            paginated={
                "records": [
                    {
                        "uuid": "n1",
                        "name": "lif1",
                        "ip": {"address": "10.0.0.1"},
                        "scope": "svm",
                        "services": ["data_nfs", "data_cifs"],
                        "svm": {"name": "svm1"},
                        "state": "up",
                    },
                ]
            }
        )
        resp = _adapter().execute(CFG, CRED, "listNetworkInterfaces", {})
        assert resp.error is None
        n = resp.nodes[0]
        assert n.metadata["ip_address"] == "10.0.0.1"
        assert n.metadata["services"] == ["data_nfs", "data_cifs"]
