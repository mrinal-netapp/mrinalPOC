"""Unit tests for anf_common ARM helpers and client."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from anf_common import (  # noqa: E402
    MIN_POOL_SIZE_BYTES,
    MIN_VOLUME_USAGE_THRESHOLD_BYTES,
    AnfAuthError,
    AnfClient,
    AnfHTTPError,
    AnfValidationError,
    arm_bearer_token,
    build_credential,
    build_pool_arm_id,
    build_volume_arm_id,
    kql_string_literal,
    parse_pool_resource_id,
    parse_resource_id,
    pool_patch_body,
    resource_group_from_arm,
    strip_insights_suffix,
    validate_region_slug,
    validate_subscription_id,
    volume_context_from_parsed,
    volume_patch_body,
)
from tests.fixtures.azure_monitor_responses import (  # noqa: E402
    FIXTURE_NETAPP_ACCOUNT,
    FIXTURE_POOL_ARM_ID,
    FIXTURE_POOL_NAME,
    FIXTURE_SUBSCRIPTION_ID,
    FIXTURE_VOLUME_ARM_ID,
    FIXTURE_VOLUME_NAME,
)

VALID_ARM = FIXTURE_VOLUME_ARM_ID
METRIC_ID = f"{VALID_ARM}/providers/Microsoft.Insights/metrics/ReadIops"


class TestParseResourceId:
    def test_valid_arm_from_metric_id(self):
        parsed = parse_resource_id(METRIC_ID)
        assert parsed is not None
        assert parsed["volume_name"] == FIXTURE_VOLUME_NAME
        assert parsed["volume_id"] == VALID_ARM
        assert parsed["subscription_id"] == FIXTURE_SUBSCRIPTION_ID

    def test_malformed(self):
        assert parse_resource_id("") is None
        assert parse_resource_id("/subscriptions/x") is None


class TestParsePoolResourceId:
    def test_valid_pool(self):
        parsed = parse_pool_resource_id(FIXTURE_POOL_ARM_ID)
        assert parsed is not None
        assert parsed["pool_name"] == FIXTURE_POOL_NAME
        assert parsed["netapp_account"] == FIXTURE_NETAPP_ACCOUNT

    def test_volume_path_rejected(self):
        assert parse_pool_resource_id(VALID_ARM) is None


class TestPatchBodies:
    def test_pool_patch_body(self):
        assert pool_patch_body(MIN_POOL_SIZE_BYTES) == {
            "properties": {"size": MIN_POOL_SIZE_BYTES}
        }

    def test_volume_patch_body(self):
        assert volume_patch_body(MIN_VOLUME_USAGE_THRESHOLD_BYTES) == {
            "properties": {"usageThreshold": MIN_VOLUME_USAGE_THRESHOLD_BYTES}
        }


class TestResourceGroupFromArm:
    def test_missing_segment(self):
        assert resource_group_from_arm("/subscriptions/s/providers/foo") == ""

    def test_trailing_resource_groups_segment(self):
        assert resource_group_from_arm("/subscriptions/s/resourceGroups") == ""


class TestKqlValidation:
    def test_kql_string_literal_escapes_single_quotes(self):
        assert kql_string_literal("rg'anf") == "rg''anf"

    def test_validate_subscription_id_accepts_guid(self):
        assert (
            validate_subscription_id(FIXTURE_SUBSCRIPTION_ID)
            == FIXTURE_SUBSCRIPTION_ID
        )

    def test_validate_subscription_id_rejects_invalid(self):
        with pytest.raises(AnfValidationError, match="GUID"):
            validate_subscription_id("not-a-guid")

    def test_validate_region_slug_accepts_slug(self):
        assert validate_region_slug("East US") == "eastus"

    def test_validate_region_slug_rejects_invalid(self):
        with pytest.raises(AnfValidationError, match="region slug"):
            validate_region_slug("east'us")


class TestArmHelpers:
    def test_strip_insights_suffix(self):
        metric_id = (
            f"{FIXTURE_VOLUME_ARM_ID}/providers/Microsoft.Insights/metrics/ReadIops"
        )
        assert strip_insights_suffix(metric_id) == FIXTURE_VOLUME_ARM_ID

    def test_build_pool_arm_id(self):
        assert build_pool_arm_id(
            FIXTURE_SUBSCRIPTION_ID, "rg-anf-dev", FIXTURE_NETAPP_ACCOUNT, FIXTURE_POOL_NAME
        ) == FIXTURE_POOL_ARM_ID

    def test_build_volume_arm_id(self):
        assert build_volume_arm_id(
            FIXTURE_SUBSCRIPTION_ID,
            "rg-anf-dev",
            FIXTURE_NETAPP_ACCOUNT,
            FIXTURE_POOL_NAME,
            FIXTURE_VOLUME_NAME,
        ) == FIXTURE_VOLUME_ARM_ID

    def test_volume_context_from_parsed_with_service_level(self):
        parsed = parse_resource_id(FIXTURE_VOLUME_ARM_ID)
        assert parsed is not None
        parsed["service_level"] = "Premium"
        ctx = volume_context_from_parsed(parsed)
        assert ctx["service_level"] == "Premium"


class TestBuildCredential:
    def test_missing_keys(self):
        with pytest.raises(ValueError, match="missing required keys"):
            build_credential({"tenant_id": "t"})

    def test_happy_path(self):
        azure_identity = MagicMock()
        mock_cls = MagicMock()
        azure_identity.ClientSecretCredential = mock_cls
        with patch.dict(sys.modules, {"azure.identity": azure_identity}):
            build_credential(
                {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
            )
        mock_cls.assert_called_once_with(
            tenant_id="t", client_id="c", client_secret="s"
        )


class TestArmBearerToken:
    def test_returns_token(self):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok-123")
        assert arm_bearer_token(cred) == "tok-123"


class TestAnfClientInit:
    def test_requires_subscription_id(self):
        with pytest.raises(ValueError, match="subscription_id"):
            AnfClient(
                {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
                subscription_id="",
                region="eastus",
            )

    def test_requires_region(self):
        with pytest.raises(ValueError, match="region"):
            AnfClient(
                {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
                subscription_id=FIXTURE_SUBSCRIPTION_ID,
                region="",
            )

    def test_rejects_invalid_subscription_id(self):
        with pytest.raises(AnfValidationError, match="GUID"):
            AnfClient(
                {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
                subscription_id="not-a-guid",
                region="eastus",
            )

    def test_rejects_invalid_region_slug(self):
        with pytest.raises(AnfValidationError, match="region slug"):
            AnfClient(
                {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
                subscription_id=FIXTURE_SUBSCRIPTION_ID,
                region="east'us",
            )


class TestAnfClientValidation:
    def test_pool_resize_below_minimum(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        with pytest.raises(AnfValidationError, match="1 TiB"):
            client.validate_pool_resize(MIN_POOL_SIZE_BYTES - 1)

    def test_volume_resize_rejects_non_positive(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        with pytest.raises(AnfValidationError, match="positive"):
            client.patch_volume_usage_threshold(FIXTURE_VOLUME_ARM_ID, 0)

    def test_get_volume_rejects_invalid_arm(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        with pytest.raises(AnfValidationError, match="full ARM"):
            client.get_volume("not-a-path")
        with pytest.raises(AnfValidationError, match="invalid volume ARM"):
            client.get_volume("/subscriptions/x/resourceGroups/rg/providers/foo")

    def test_resolve_pool_arm_id_from_components(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
            resource_group="rg-anf-dev",
        )
        path = client.resolve_pool_arm_id(
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            resource_group="rg-anf-dev",
            netapp_account=FIXTURE_NETAPP_ACCOUNT,
            pool_name=FIXTURE_POOL_NAME,
        )
        assert path == FIXTURE_POOL_ARM_ID

    def test_resolve_pool_arm_id_missing_components(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        with pytest.raises(AnfValidationError, match="missing"):
            client.resolve_pool_arm_id(pool_name=FIXTURE_POOL_NAME)

    def test_pool_shrink_requires_allow_shrink(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client._azure_cred = cred
        with patch.object(
            client,
            "_get",
            return_value={"properties": {"size": MIN_POOL_SIZE_BYTES * 2}},
        ):
            with pytest.raises(AnfValidationError, match="allow_shrink"):
                client.patch_capacity_pool_size(
                    FIXTURE_POOL_ARM_ID, MIN_POOL_SIZE_BYTES
                )


class TestListVolumesSummary:
    def test_list_volumes_default_is_summary_not_n_plus_one(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        ctx = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "resource_group": "rg-anf-dev",
            "netapp_account": FIXTURE_NETAPP_ACCOUNT,
            "pool_name": FIXTURE_POOL_NAME,
            "pool_id": FIXTURE_POOL_ARM_ID,
            "volume_name": FIXTURE_VOLUME_NAME,
            "volume_id": FIXTURE_VOLUME_ARM_ID,
            "service_level": "Standard",
        }
        with patch.object(client, "list_volume_contexts", return_value=[ctx]):
            rows = client.list_volumes()
        assert len(rows) == 1
        assert rows[0]["volume_id"] == FIXTURE_VOLUME_ARM_ID
        assert rows[0]["volume_name"] == FIXTURE_VOLUME_NAME
        assert "properties" not in rows[0]

    def test_list_volumes_full_resource(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        ctx = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "resource_group": "rg-anf-dev",
            "netapp_account": FIXTURE_NETAPP_ACCOUNT,
            "pool_name": FIXTURE_POOL_NAME,
            "pool_id": FIXTURE_POOL_ARM_ID,
            "volume_name": FIXTURE_VOLUME_NAME,
            "volume_id": FIXTURE_VOLUME_ARM_ID,
        }
        with patch.object(client, "list_volume_contexts", return_value=[ctx]):
            with patch.object(
                client,
                "get_volume",
                return_value={"id": FIXTURE_VOLUME_ARM_ID, "properties": {}},
            ):
                rows = client.list_volumes(full_resource=True)
        assert rows[0]["id"] == FIXTURE_VOLUME_ARM_ID


class TestListVolumeContexts:
    @patch("anf_common.client.requests.post")
    def test_resource_graph_path(self, mock_post):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred
        mock_post.return_value = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"data": [{"id": FIXTURE_VOLUME_ARM_ID}]}),
        )
        contexts = client.list_volume_contexts()
        assert len(contexts) == 1
        assert contexts[0]["volume_id"] == FIXTURE_VOLUME_ARM_ID
        query = mock_post.call_args.kwargs["json"]["query"]
        assert "subscriptionId == '" in query
        assert "tolower(location) == 'eastus'" in query

    def test_resource_graph_rejects_invalid_subscription_override(self):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred
        with pytest.raises(AnfValidationError, match="GUID"):
            client.list_volumes_resource_graph(subscription_id="bad'input")

    @patch("anf_common.client.requests.get")
    @patch("anf_common.client.requests.post")
    def test_arm_fallback_when_resource_graph_empty(self, mock_post, mock_get):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred
        mock_post.return_value = MagicMock(status_code=404, text="not found")

        accounts_resp = MagicMock(status_code=200)
        accounts_resp.json.return_value = {
            "value": [
                {
                    "id": f"/subscriptions/{FIXTURE_SUBSCRIPTION_ID}/resourceGroups/rg-anf-dev/providers/Microsoft.NetApp/netAppAccounts/{FIXTURE_NETAPP_ACCOUNT}",
                    "name": FIXTURE_NETAPP_ACCOUNT,
                    "location": "eastus",
                }
            ]
        }
        pools_resp = MagicMock(status_code=200)
        pools_resp.json.return_value = {
            "value": [
                {
                    "id": FIXTURE_POOL_ARM_ID,
                    "properties": {"serviceLevel": "Premium"},
                }
            ]
        }
        vols_resp = MagicMock(status_code=200)
        vols_resp.json.return_value = {
            "value": [{"id": FIXTURE_VOLUME_ARM_ID}]
        }
        mock_get.side_effect = [accounts_resp, pools_resp, vols_resp]

        contexts = client.list_volume_contexts()
        assert len(contexts) == 1
        assert contexts[0]["volume_name"] == FIXTURE_VOLUME_NAME

    @patch("anf_common.client.requests.get")
    def test_enrich_volumes_service_level(self, mock_get):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred
        pool_resp = MagicMock(status_code=200)
        pool_resp.json.return_value = {
            "properties": {"serviceLevel": "Premium"},
        }
        mock_get.return_value = pool_resp
        volumes = [
            {
                "volume_id": FIXTURE_VOLUME_ARM_ID,
                "pool_id": FIXTURE_POOL_ARM_ID,
            }
        ]
        enriched = client.enrich_volumes_service_level(volumes)
        assert enriched[0]["service_level"] == "Premium"


class TestListCapacityPools:
    @patch("anf_common.client.requests.get")
    def test_list_capacity_pools_arm_enumerate(self, mock_get):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
            resource_group="rg-anf-dev",
        )
        client._azure_cred = cred

        accounts_resp = MagicMock(status_code=200)
        accounts_resp.json.return_value = {
            "value": [
                {
                    "id": f"/subscriptions/{FIXTURE_SUBSCRIPTION_ID}/resourceGroups/rg-anf-dev/providers/Microsoft.NetApp/netAppAccounts/{FIXTURE_NETAPP_ACCOUNT}",
                    "name": FIXTURE_NETAPP_ACCOUNT,
                    "location": "eastus",
                }
            ]
        }
        pools_resp = MagicMock(status_code=200)
        pools_resp.json.return_value = {
            "value": [{"id": FIXTURE_POOL_ARM_ID, "name": FIXTURE_POOL_NAME}]
        }
        mock_get.side_effect = [accounts_resp, pools_resp]

        pools = client.list_capacity_pools(netapp_account=FIXTURE_NETAPP_ACCOUNT)
        assert len(pools) == 1
        assert pools[0]["id"] == FIXTURE_POOL_ARM_ID


class TestRaiseForStatus:
    @patch("anf_common.client.requests.get")
    def test_auth_error_on_401(self, mock_get):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred
        mock_get.return_value = MagicMock(status_code=401, text="unauthorized")
        with pytest.raises(AnfAuthError):
            client.get_volume(FIXTURE_VOLUME_ARM_ID)

    @patch("anf_common.client.requests.get")
    def test_http_error_on_500(self, mock_get):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred
        mock_get.return_value = MagicMock(status_code=500, text="boom")
        with pytest.raises(AnfHTTPError):
            client.get_volume(FIXTURE_VOLUME_ARM_ID)


class TestAnfClientPatch:
    @patch("anf_common.client.requests.patch")
    @patch("anf_common.client.requests.get")
    def test_patch_capacity_pool_size(self, mock_get, mock_patch):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred

        get_resp = MagicMock()
        get_resp.status_code = 200
        get_resp.json.return_value = {
            "properties": {"size": MIN_POOL_SIZE_BYTES},
        }
        mock_get.return_value = get_resp

        patch_resp = MagicMock()
        patch_resp.status_code = 200
        patch_resp.json.return_value = {"id": FIXTURE_POOL_ARM_ID}
        mock_patch.return_value = patch_resp

        new_size = MIN_POOL_SIZE_BYTES * 2
        result = client.patch_capacity_pool_size(FIXTURE_POOL_ARM_ID, new_size)
        assert result["id"] == FIXTURE_POOL_ARM_ID
        mock_patch.assert_called_once()
        body = mock_patch.call_args.kwargs["json"]
        assert body == pool_patch_body(new_size)

    @patch("anf_common.client.requests.patch")
    def test_patch_volume_usage_threshold(self, mock_patch):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=FIXTURE_SUBSCRIPTION_ID,
            region="eastus",
        )
        client._azure_cred = cred

        patch_resp = MagicMock()
        patch_resp.status_code = 200
        patch_resp.json.return_value = {"id": FIXTURE_VOLUME_ARM_ID}
        mock_patch.return_value = patch_resp

        new_size = 50 * (1 << 30)
        result = client.patch_volume_usage_threshold(FIXTURE_VOLUME_ARM_ID, new_size)
        assert result["id"] == FIXTURE_VOLUME_ARM_ID
        body = mock_patch.call_args.kwargs["json"]
        assert body == volume_patch_body(new_size)
