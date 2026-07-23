"""Unit tests for the GCP adapter."""

import json
from unittest.mock import MagicMock, patch


from adapters.gcp_adapter import (
    GCPAdapter,
    _api_not_enabled_response,
    _gcnv_locations_for_scope,
    _gcnv_monitoring_location_filter,
    _is_gcp_zone,
    _region_from_zone,
    _zones_in_region,
)

FAKE_SA_JSON = json.dumps(
    {
        "type": "service_account",
        "project_id": "test-project",
        "private_key_id": "key123",
        "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAH\n-----END RSA PRIVATE KEY-----\n",
        "client_email": "test@test-project.iam.gserviceaccount.com",
        "client_id": "123456789",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
)

CONNECTOR_CONFIG = {"project_id": "test-project", "default_region": "us-central1"}
CREDENTIAL = {"service_account_json": FAKE_SA_JSON}


class TestRegionFromZone:
    def test_standard_zone(self):
        assert _region_from_zone("us-central1-a") == "us-central1"

    def test_zone_b(self):
        assert _region_from_zone("europe-west1-b") == "europe-west1"

    def test_already_region(self):
        assert _region_from_zone("us-central1") == "us-central1"

    def test_empty(self):
        assert _region_from_zone("") == ""


class TestGcpZoneDetection:
    def test_zone_suffix(self):
        assert _is_gcp_zone("us-central1-a") is True
        assert _is_gcp_zone("europe-west1-c") is True

    def test_region_not_zone(self):
        assert _is_gcp_zone("us-central1") is False
        assert _is_gcp_zone("europe-west1") is False

    def test_monitoring_filter_region_includes_zones(self):
        clause = _gcnv_monitoring_location_filter("us-central1")
        assert 'resource.labels.location = "us-central1"' in clause
        assert 'monitoring.regex.full_match("us-central1-[a-z]")' in clause

    def test_monitoring_filter_zone_exact(self):
        clause = _gcnv_monitoring_location_filter("us-central1-a")
        assert clause == ' AND resource.labels.location = "us-central1-a"'
        assert "regex" not in clause


class TestListServices:
    def setup_method(self):
        self.adapter = GCPAdapter()

    def test_returns_four_categories(self):
        resp = self.adapter._list_services({"region": "us-central1"})
        assert len(resp.nodes) == 4
        labels = [n.label for n in resp.nodes]
        assert "Database Services" in labels
        assert "NetApp Volumes" in labels
        assert "Cloud Storage" in labels
        # Performance Metrics is project-scoped, not regional.
        assert "Performance Metrics" in labels

    def test_region_propagated(self):
        resp = self.adapter._list_services({"region": "europe-west1"})
        for node in resp.nodes:
            # The metrics branch is project-scoped and intentionally has no
            # "region" key (see GCPAdapter._list_services). Only assert
            # region propagation on the regional service nodes.
            if node.resource.get("service") == "metrics":
                continue
            assert node.resource["region"] == "europe-west1"


class TestListMetricCategories:
    """Unified GCP connector serves listMetricCategories synthetically.

    GCNV metrics live in Cloud Monitoring at project scope, so the metrics
    branch sits alongside regions in _list_regions output and the action
    returns a project-scoped leaf set.
    """

    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter._build_credentials")
    def test_returns_gcnv_metric_category_leaves(self, mock_creds):
        mock_creds.return_value = MagicMock()
        resp = self.adapter.execute(
            CONNECTOR_CONFIG, CREDENTIAL, "listMetricCategories", {}
        )
        assert resp.error is None
        types = {n.type for n in resp.nodes}
        assert types == {"metric_category"}
        cats = sorted([(n.resource or {}).get("category") for n in resp.nodes])
        assert cats == ["pool_metrics", "volume_metrics", "volume_tier_metrics"]
        for n in resp.nodes:
            assert n.children_hint == "leaf"


class TestListDbSubServices:
    def setup_method(self):
        self.adapter = GCPAdapter()

    def test_returns_three_db_services(self):
        resp = self.adapter._list_db_sub_services("us-central1")
        assert len(resp.nodes) == 3
        labels = [n.label for n in resp.nodes]
        assert "Cloud SQL" in labels
        assert "Cloud Spanner" in labels
        assert "AlloyDB" in labels


class TestCloudSQLRegionFiltering:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.build")
    @patch("adapters.gcp_adapter._build_credentials")
    def test_filters_by_region(self, mock_creds, mock_build):
        mock_creds.return_value = MagicMock()
        svc = MagicMock()
        mock_build.return_value = svc
        svc.instances.return_value.list.return_value.execute.return_value = {
            "items": [
                {
                    "name": "inst-central",
                    "gceZone": "us-central1-a",
                    "databaseVersion": "POSTGRES_15",
                    "state": "RUNNABLE",
                    "settings": {"tier": "db-f1-micro"},
                },
                {
                    "name": "inst-east",
                    "gceZone": "us-east1-b",
                    "databaseVersion": "MYSQL_8_0",
                    "state": "RUNNABLE",
                    "settings": {"tier": "db-f1-micro"},
                },
            ]
        }

        resp = self.adapter._list_cloudsql_instances(
            MagicMock(), "test-project", "us-central1"
        )
        assert len(resp.nodes) == 1
        assert resp.nodes[0].label == "inst-central"
        assert resp.nodes[0].kind == "postgresql"

    @patch("adapters.gcp_adapter.build")
    @patch("adapters.gcp_adapter._build_credentials")
    def test_no_filter_when_region_empty(self, mock_creds, mock_build):
        mock_creds.return_value = MagicMock()
        svc = MagicMock()
        mock_build.return_value = svc
        svc.instances.return_value.list.return_value.execute.return_value = {
            "items": [
                {
                    "name": "inst1",
                    "gceZone": "us-central1-a",
                    "databaseVersion": "POSTGRES_15",
                    "state": "RUNNABLE",
                    "settings": {"tier": "t"},
                },
                {
                    "name": "inst2",
                    "gceZone": "us-east1-b",
                    "databaseVersion": "MYSQL_8_0",
                    "state": "RUNNABLE",
                    "settings": {"tier": "t"},
                },
            ]
        }

        resp = self.adapter._list_cloudsql_instances(MagicMock(), "test-project", "")
        assert len(resp.nodes) == 2


class TestCloudSQLDatabases:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.build")
    def test_lists_databases(self, mock_build):
        svc = MagicMock()
        mock_build.return_value = svc
        svc.databases.return_value.list.return_value.execute.return_value = {
            "items": [
                {"name": "mydb", "charset": "utf8", "collation": "utf8_general_ci"},
                {"name": "postgres", "charset": "utf8", "collation": ""},
            ]
        }

        resp = self.adapter._list_cloudsql_databases(
            MagicMock(), "test-project", "inst1"
        )
        assert len(resp.nodes) == 2
        assert resp.nodes[0].type == "database"
        assert resp.nodes[0].children_hint == "leaf"


class TestAlloyDBLeafInstances:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.build")
    def test_instances_are_leaf(self, mock_build):
        svc = MagicMock()
        mock_build.return_value = svc
        svc.projects.return_value.locations.return_value.clusters.return_value.instances.return_value.list.return_value.execute.return_value = {
            "instances": [
                {
                    "name": "projects/test/locations/us-central1/clusters/c1/instances/primary",
                    "instanceType": "PRIMARY",
                    "state": "READY",
                    "ipAddress": "10.0.0.1",
                    "databaseVersion": "POSTGRES_15",
                },
            ]
        }

        resp = self.adapter._list_alloydb_instances(
            MagicMock(),
            "test-project",
            {"cluster": "projects/test/locations/us-central1/clusters/c1"},
        )
        assert len(resp.nodes) == 1
        assert resp.nodes[0].children_hint == "leaf"
        assert resp.nodes[0].type == "instance"
        assert resp.nodes[0].kind == "alloydb"
        assert resp.nodes[0].metadata["ipAddress"] == "10.0.0.1"


class TestAPINotEnabled:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.build")
    def test_cloudsql_api_not_enabled(self, mock_build):
        from googleapiclient.errors import HttpError
        import httplib2

        svc = MagicMock()
        mock_build.return_value = svc
        resp = httplib2.Response({"status": "403"})
        error = HttpError(
            resp, b'{"error": {"message": "Cloud SQL Admin API has not been used"}}'
        )
        svc.instances.return_value.list.return_value.execute.side_effect = error

        result = self.adapter._list_cloudsql_instances(
            MagicMock(), "test-project", "us-central1"
        )
        assert result.error is not None
        assert result.error.code == "API_NOT_ENABLED"
        assert "Cloud SQL Admin" in result.error.message


class TestSpannerMultiRegion:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.build")
    def test_multi_region_not_filtered(self, mock_build):
        svc = MagicMock()
        mock_build.return_value = svc
        svc.projects.return_value.instances.return_value.list.return_value.execute.return_value = {
            "instances": [
                {
                    "name": "projects/test/instances/regional-inst",
                    "displayName": "Regional Inst",
                    "config": "projects/test/instanceConfigs/regional-us-central1",
                    "state": "READY",
                    "nodeCount": 1,
                },
                {
                    "name": "projects/test/instances/multi-inst",
                    "displayName": "Multi Inst",
                    "config": "projects/test/instanceConfigs/nam-eur-asia1",
                    "state": "READY",
                    "nodeCount": 3,
                },
            ]
        }

        resp = self.adapter._list_spanner_instances(
            MagicMock(), "test-project", "us-central1"
        )
        assert len(resp.nodes) == 2
        labels = [n.label for n in resp.nodes]
        assert "Regional Inst" in labels
        assert "Multi Inst" in labels

    @patch("adapters.gcp_adapter.build")
    def test_regional_filtered_out(self, mock_build):
        svc = MagicMock()
        mock_build.return_value = svc
        svc.projects.return_value.instances.return_value.list.return_value.execute.return_value = {
            "instances": [
                {
                    "name": "projects/test/instances/east-inst",
                    "displayName": "East Inst",
                    "config": "projects/test/instanceConfigs/regional-us-east1",
                    "state": "READY",
                    "nodeCount": 1,
                },
            ]
        }

        resp = self.adapter._list_spanner_instances(
            MagicMock(), "test-project", "us-central1"
        )
        assert len(resp.nodes) == 0


class TestGCNVVolumes:
    def setup_method(self):
        self.adapter = GCPAdapter()

    def _mock_netapp_with_locations(
        self, mock_build, *, regional_pools=None, zonal_pools=None
    ):
        netapp_svc = MagicMock()
        mock_build.return_value = netapp_svc

        def locations_list(name):
            mock = MagicMock()
            mock.execute.return_value = {
                "locations": [
                    {"locationId": "us-central1"},
                    {"locationId": "us-central1-a"},
                    {"locationId": "us-central1-b"},
                    {"locationId": "us-east1-b"},
                ]
            }
            return mock

        def pools_list(parent):
            mock = MagicMock()
            if parent.endswith("/locations/us-central1"):
                mock.execute.return_value = {"storagePools": regional_pools or []}
            elif parent.endswith("/locations/us-central1-a"):
                mock.execute.return_value = {"storagePools": zonal_pools or []}
            else:
                mock.execute.return_value = {"storagePools": []}
            return mock

        netapp_svc.projects.return_value.locations.return_value.list.side_effect = (
            locations_list
        )
        netapp_svc.projects.return_value.locations.return_value.storagePools.return_value.list.side_effect = pools_list
        return netapp_svc

    @patch("adapters.gcp_adapter.build")
    def test_lists_pools(self, mock_build):
        self._mock_netapp_with_locations(
            mock_build,
            regional_pools=[
                {
                    "name": "projects/my-project/locations/us-central1/storagePools/pool-a",
                    "serviceLevel": "PREMIUM",
                    "capacityGib": "2048",
                    "state": "READY",
                },
            ],
        )
        resp = self.adapter._list_storage_pools(
            MagicMock(), "my-project", "us-central1"
        )
        assert len(resp.nodes) == 1
        assert resp.nodes[0].type == "storagePool"
        assert resp.nodes[0].resource["storagePool"].endswith("/storagePools/pool-a")

    @patch("adapters.gcp_adapter.build")
    def test_lists_zonal_pools_when_browsing_region(self, mock_build):
        self._mock_netapp_with_locations(
            mock_build,
            zonal_pools=[
                {
                    "name": "projects/my-project/locations/us-central1-a/storagePools/pool-zonal",
                    "serviceLevel": "PREMIUM",
                    "capacityGib": "1024",
                    "state": "READY",
                },
            ],
        )
        resp = self.adapter._list_storage_pools(
            MagicMock(), "my-project", "us-central1"
        )
        assert len(resp.nodes) == 1
        assert resp.nodes[0].label == "pool-zonal"
        assert resp.nodes[0].resource["region"] == "us-central1-a"

    @patch("adapters.gcp_adapter.build")
    def test_volumes_matched_despite_project_number_id_mismatch(self, mock_build):
        # Regression: the pool node carries the project-ID form (from
        # storagePools().list), but Volume.storagePool is normalized to the
        # project-NUMBER form. Matching on the full path drops every volume;
        # matching on the short pool name must keep the right ones.
        netapp_svc = MagicMock()
        mock_build.return_value = netapp_svc
        netapp_svc.projects.return_value.locations.return_value.list.return_value.execute.return_value = {
            "locations": [{"locationId": "us-central1"}],
        }

        def volumes_list(parent):
            mock = MagicMock()
            mock.execute.return_value = {
                "volumes": [
                    {
                        "name": "projects/123456789/locations/us-central1/volumes/vol-1",
                        "storagePool": "projects/123456789/locations/us-central1/storagePools/pool-a",
                        "capacityGib": "100",
                        "state": "READY",
                        "shareName": "vol1",
                        "protocols": ["NFSV3"],
                    },
                    {
                        "name": "projects/123456789/locations/us-central1/volumes/vol-2",
                        "storagePool": "projects/123456789/locations/us-central1/storagePools/pool-b",
                        "capacityGib": "200",
                        "state": "READY",
                        "shareName": "vol2",
                        "protocols": ["NFSV4"],
                    },
                ]
            }
            return mock

        netapp_svc.projects.return_value.locations.return_value.volumes.return_value.list.side_effect = volumes_list
        resp = self.adapter._list_volumes(
            MagicMock(),
            "my-project",
            {
                # project-ID form, as stored by _list_storage_pools
                "storagePool": "projects/my-project/locations/us-central1/storagePools/pool-a",
                "region": "us-central1",
            },
        )
        assert resp.error is None
        assert [n.label for n in resp.nodes] == ["vol-1"]
        assert resp.nodes[0].type == "volume"
        assert resp.nodes[0].metadata["protocol"] == "NFSV3"

    @patch("adapters.gcp_adapter.build")
    def test_volumes_no_pool_filter_returns_all(self, mock_build):
        netapp_svc = MagicMock()
        mock_build.return_value = netapp_svc
        netapp_svc.projects.return_value.locations.return_value.list.return_value.execute.return_value = {
            "locations": [
                {"locationId": "us-central1"},
                {"locationId": "us-central1-a"},
            ],
        }

        def volumes_list(parent):
            mock = MagicMock()
            if parent.endswith("/locations/us-central1"):
                mock.execute.return_value = {
                    "volumes": [
                        {
                            "name": "projects/p/locations/us-central1/volumes/v1",
                            "storagePool": "projects/p/locations/us-central1/storagePools/a",
                        },
                    ]
                }
            elif parent.endswith("/locations/us-central1-a"):
                mock.execute.return_value = {
                    "volumes": [
                        {
                            "name": "projects/p/locations/us-central1-a/volumes/v2",
                            "storagePool": "projects/p/locations/us-central1-a/storagePools/b",
                        },
                    ]
                }
            else:
                mock.execute.return_value = {"volumes": []}
            return mock

        netapp_svc.projects.return_value.locations.return_value.volumes.return_value.list.side_effect = volumes_list
        resp = self.adapter._list_volumes(MagicMock(), "p", {"region": "us-central1"})
        assert len(resp.nodes) == 2
        assert {n.label for n in resp.nodes} == {"v1", "v2"}

    @patch("adapters.gcp_adapter.build")
    def test_volumes_in_zonal_pool_use_zone_location(self, mock_build):
        netapp_svc = MagicMock()
        mock_build.return_value = netapp_svc

        def volumes_list(parent):
            mock = MagicMock()
            if parent.endswith("/locations/us-central1-a"):
                mock.execute.return_value = {
                    "volumes": [
                        {
                            "name": "projects/p/locations/us-central1-a/volumes/zonal-vol",
                            "storagePool": "projects/p/locations/us-central1-a/storagePools/pool-zonal",
                            "state": "READY",
                        },
                    ]
                }
            else:
                mock.execute.return_value = {"volumes": []}
            return mock

        netapp_svc.projects.return_value.locations.return_value.volumes.return_value.list.side_effect = volumes_list
        resp = self.adapter._list_volumes(
            MagicMock(),
            "p",
            {
                "storagePool": "projects/p/locations/us-central1-a/storagePools/pool-zonal",
                "region": "us-central1-a",
            },
        )
        assert [n.label for n in resp.nodes] == ["zonal-vol"]


class TestGCSBuckets:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.storage")
    def test_lists_all_buckets(self, mock_storage):
        mock_client = MagicMock()
        mock_storage.Client.return_value = mock_client
        bucket1 = MagicMock()
        bucket1.name = "bucket-a"
        bucket1.location = "US"
        bucket1.storage_class = "STANDARD"
        bucket2 = MagicMock()
        bucket2.name = "bucket-b"
        bucket2.location = "EUROPE-WEST1"
        bucket2.storage_class = "NEARLINE"
        mock_client.list_buckets.return_value = [bucket1, bucket2]

        resp = self.adapter._list_buckets(MagicMock(), "test-project")
        assert len(resp.nodes) == 2
        assert resp.nodes[0].type == "resource"
        assert resp.nodes[0].kind == "bucket"
        assert resp.nodes[0].metadata["location"] == "US"
        assert resp.nodes[1].metadata["location"] == "EUROPE-WEST1"


class TestExecuteDispatch:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter._build_credentials")
    def test_unsupported_action(self, mock_creds):
        mock_creds.return_value = MagicMock()
        resp = self.adapter.execute(
            CONNECTOR_CONFIG, CREDENTIAL, "nonExistentAction", {}
        )
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"

    def test_invalid_json_credential(self):
        resp = self.adapter.execute(
            CONNECTOR_CONFIG, {"service_account_json": "not-json"}, "listRegions", {}
        )
        assert resp.error is not None
        assert resp.error.code == "CREDENTIAL_ERROR"

    @patch("adapters.gcp_adapter._build_credentials")
    def test_listservices_dispatches(self, mock_creds):
        # The FAKE_SA_JSON fixture isn't a parseable PEM; stub out
        # credential construction so this test exercises the dispatcher
        # rather than `cryptography` PEM parsing. Sibling tests in this
        # class use the same pattern.
        mock_creds.return_value = MagicMock()
        resp = self.adapter.execute(
            CONNECTOR_CONFIG, CREDENTIAL, "listServices", {"region": "us-central1"}
        )
        assert resp.error is None
        assert len(resp.nodes) == 4


class TestListDatabasesDispatch:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter._build_credentials")
    def test_missing_instance(self, mock_creds):
        mock_creds.return_value = MagicMock()
        resp = self.adapter._list_databases(
            MagicMock(), "test-project", {"service": "cloudsql"}
        )
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    @patch("adapters.gcp_adapter._build_credentials")
    def test_unsupported_service(self, mock_creds):
        mock_creds.return_value = MagicMock()
        resp = self.adapter._list_databases(
            MagicMock(), "test-project", {"service": "alloydb", "instance": "x"}
        )
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_SERVICE"


class TestAlloyDBMissingCluster:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter._build_credentials")
    def test_missing_cluster(self, mock_creds):
        mock_creds.return_value = MagicMock()
        resp = self.adapter._list_alloydb_instances(MagicMock(), "test-project", {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"


class TestGcpLocationHelpers:
    @patch("adapters.gcp_adapter.build")
    def test_zones_in_region_http_error_returns_empty(self, mock_build):
        from googleapiclient.errors import HttpError

        resp_obj = MagicMock()
        resp_obj.status = 403
        mock_build.return_value.zones.return_value.list.return_value.execute.side_effect = HttpError(
            resp_obj,
            b"forbidden",
        )
        assert _zones_in_region(MagicMock(), "proj", "us-central1") == []

    def test_gcnv_locations_for_zone_returns_single(self):
        netapp = MagicMock()
        creds = MagicMock()
        assert _gcnv_locations_for_scope(netapp, creds, "p", "us-central1-a") == [
            "us-central1-a"
        ]

    @patch("adapters.gcp_adapter._zones_in_region")
    def test_gcnv_locations_falls_back_to_compute_zones(self, mock_zones):
        from googleapiclient.errors import HttpError

        netapp = MagicMock()
        resp_obj = MagicMock()
        resp_obj.status = 403
        netapp.projects.return_value.locations.return_value.list.return_value.execute.side_effect = HttpError(
            resp_obj,
            b"forbidden",
        )
        mock_zones.return_value = ["us-central1-a", "us-central1-b"]
        out = _gcnv_locations_for_scope(netapp, MagicMock(), "p", "us-central1")
        assert "us-central1" in out
        assert "us-central1-a" in out

    def test_api_not_enabled_response_detects_disabled_api(self):
        from googleapiclient.errors import HttpError

        resp_obj = MagicMock()
        resp_obj.status = 403
        err = HttpError(resp_obj, b"Cloud Storage API has not been used")
        resp = _api_not_enabled_response("Cloud Storage", err)
        assert resp.error.code == "API_NOT_ENABLED"

    def test_api_not_enabled_response_generic_error(self):
        from googleapiclient.errors import HttpError

        resp_obj = MagicMock()
        resp_obj.status = 500
        err = HttpError(resp_obj, b"internal error")
        resp = _api_not_enabled_response("Cloud Storage", err)
        assert resp.error.code == "PROVIDER_ERROR"


class TestListPath:
    @patch("adapters.gcp_adapter.storage")
    @patch("adapters.gcp_adapter._build_credentials")
    def test_list_path_returns_folders_and_files(self, mock_creds, mock_storage):
        mock_creds.return_value = MagicMock()
        blob = MagicMock()
        blob.name = "data/file.txt"
        blob.size = 42
        blob.updated = None

        iterator = MagicMock()
        iterator.prefixes = {"data/subdir/"}
        iterator.next_page_token = "next-1"
        iterator.__iter__ = MagicMock(return_value=iter([blob]))
        mock_storage.Client.return_value.bucket.return_value.list_blobs.return_value = (
            iterator
        )

        adapter = GCPAdapter()
        resp = adapter._list_path(
            MagicMock(),
            "proj",
            {
                "bucket": "my-bucket",
                "prefix": "data/",
            },
        )
        assert resp.error is None
        assert len(resp.nodes) == 2
        assert resp.next_token == "next-1"
        types = {n.type for n in resp.nodes}
        assert types == {"folder", "file"}

    @patch("adapters.gcp_adapter._build_credentials")
    def test_list_path_requires_bucket(self, mock_creds):
        mock_creds.return_value = MagicMock()
        resp = GCPAdapter()._list_path(MagicMock(), "proj", {})
        assert resp.error.code == "VALIDATION_ERROR"
