"""Unit tests for vendored anf_common (mirrors connector-worker coverage)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_IMAGE_ROOT = Path(__file__).resolve().parents[1]
if str(_IMAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_IMAGE_ROOT))

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
    parse_pool_resource_id,
    parse_resource_id,
    pool_patch_body,
    resource_group_from_arm,
    strip_insights_suffix,
    volume_context_from_parsed,
    volume_patch_body,
)

_SUB = "00000000-0000-0000-0000-000000000001"
_ACCOUNT = "acct1"
_POOL = "pool1"
_VOL = "vol1"
_RG = "rg-anf-dev"
_POOL_ARM_ID = (
    f"/subscriptions/{_SUB}/resourceGroups/{_RG}/providers/Microsoft.NetApp/"
    f"netAppAccounts/{_ACCOUNT}/capacityPools/{_POOL}"
)
_VOLUME_ARM_ID = f"{_POOL_ARM_ID}/volumes/{_VOL}"
METRIC_ID = f"{_VOLUME_ARM_ID}/providers/Microsoft.Insights/metrics/ReadIops"


class TestParseResourceId:
    def test_valid_arm_from_metric_id(self):
        parsed = parse_resource_id(METRIC_ID)
        assert parsed is not None
        assert parsed["volume_name"] == _VOL

    def test_malformed(self):
        assert parse_resource_id("") is None


class TestArmHelpers:
    def test_strip_insights_suffix(self):
        assert strip_insights_suffix(METRIC_ID) == _VOLUME_ARM_ID

    def test_build_pool_and_volume_arm_id(self):
        assert build_pool_arm_id(_SUB, _RG, _ACCOUNT, _POOL) == _POOL_ARM_ID
        assert build_volume_arm_id(_SUB, _RG, _ACCOUNT, _POOL, _VOL) == _VOLUME_ARM_ID

    def test_volume_context_from_parsed_with_service_level(self):
        parsed = parse_resource_id(_VOLUME_ARM_ID)
        assert parsed is not None
        parsed["service_level"] = "Premium"
        assert volume_context_from_parsed(parsed)["service_level"] == "Premium"


class TestBuildCredential:
    def test_missing_keys(self):
        with pytest.raises(ValueError, match="missing required keys"):
            build_credential({"tenant_id": "t"})

    def test_happy_path(self):
        azure_identity = MagicMock()
        mock_cls = MagicMock()
        azure_identity.ClientSecretCredential = mock_cls
        with patch.dict(sys.modules, {"azure.identity": azure_identity}):
            build_credential({"tenant_id": "t", "client_id": "c", "client_secret": "s"})
        mock_cls.assert_called_once()


class TestAnfClient:
    def test_init_requires_subscription_and_region(self):
        cred = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        with pytest.raises(ValueError, match="subscription_id"):
            AnfClient(cred, subscription_id="", region="eastus")
        with pytest.raises(ValueError, match="region"):
            AnfClient(cred, subscription_id=_SUB, region="")

    @patch("anf_common.client.requests.get")
    def test_get_volume_and_list_pools(self, mock_get):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus", resource_group=_RG)
        client._azure_cred = azure_cred

        vol_resp = MagicMock(status_code=200)
        vol_resp.json.return_value = {"id": _VOLUME_ARM_ID}
        accounts_resp = MagicMock(status_code=200)
        accounts_resp.json.return_value = {
            "value": [
                {
                    "id": f"/subscriptions/{_SUB}/resourceGroups/{_RG}/providers/Microsoft.NetApp/netAppAccounts/{_ACCOUNT}",
                    "name": _ACCOUNT,
                    "location": "eastus",
                }
            ]
        }
        pools_resp = MagicMock(status_code=200)
        pools_resp.json.return_value = {"value": [{"id": _POOL_ARM_ID}]}
        mock_get.side_effect = [vol_resp, accounts_resp, pools_resp]

        assert client.get_volume(_VOLUME_ARM_ID)["id"] == _VOLUME_ARM_ID
        pools = client.list_capacity_pools(netapp_account=_ACCOUNT)
        assert pools[0]["id"] == _POOL_ARM_ID

    @patch("anf_common.client.requests.post")
    def test_list_volume_contexts_resource_graph(self, mock_post):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        client._azure_cred = azure_cred
        mock_post.return_value = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"data": [{"id": _VOLUME_ARM_ID}]}),
        )
        contexts = client.list_volume_contexts()
        assert contexts[0]["volume_id"] == _VOLUME_ARM_ID

    @patch("anf_common.client.requests.patch")
    @patch("anf_common.client.requests.get")
    def test_patch_pool_and_volume(self, mock_get, mock_patch):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        client._azure_cred = azure_cred

        mock_get.return_value = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"properties": {"size": MIN_POOL_SIZE_BYTES}}),
        )
        mock_patch.return_value = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"id": _POOL_ARM_ID}),
        )
        grown = MIN_POOL_SIZE_BYTES * 2
        assert client.patch_capacity_pool_size(_POOL_ARM_ID, grown)["id"] == _POOL_ARM_ID

        mock_patch.return_value = MagicMock(
            status_code=200,
            json=MagicMock(return_value={"id": _VOLUME_ARM_ID}),
        )
        size = MIN_VOLUME_USAGE_THRESHOLD_BYTES
        assert client.patch_volume_usage_threshold(_VOLUME_ARM_ID, size)["id"] == _VOLUME_ARM_ID

    def test_validation_errors(self):
        client = AnfClient(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            subscription_id=_SUB,
            region="eastus",
        )
        with pytest.raises(AnfValidationError):
            client.get_volume("bad-id")
        with pytest.raises(AnfValidationError):
            client.patch_volume_usage_threshold(_VOLUME_ARM_ID, 0)
        with pytest.raises(AnfValidationError):
            client.resolve_pool_arm_id(pool_name=_POOL)

    @patch("anf_common.client.requests.get")
    def test_raise_for_status(self, mock_get):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        client._azure_cred = azure_cred
        mock_get.return_value = MagicMock(status_code=401, text="nope")
        with pytest.raises(AnfAuthError):
            client.get_volume(_VOLUME_ARM_ID)

    def test_arm_bearer_token(self):
        cred = MagicMock()
        cred.get_token.return_value = MagicMock(token="abc")
        assert arm_bearer_token(cred) == "abc"

    def test_parse_pool_and_patch_bodies(self):
        assert parse_pool_resource_id(_POOL_ARM_ID)["pool_name"] == _POOL
        assert pool_patch_body(MIN_POOL_SIZE_BYTES)["properties"]["size"] == MIN_POOL_SIZE_BYTES
        assert resource_group_from_arm("/subscriptions/s/providers/foo") == ""
        assert resource_group_from_arm("/subscriptions/s/resourceGroups") == ""

    @patch("anf_common.client.requests.get")
    @patch("anf_common.client.requests.post")
    def test_arm_fallback_and_enrich_service_level(self, mock_post, mock_get):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        client._azure_cred = azure_cred
        mock_post.return_value = MagicMock(status_code=404, text="missing")

        accounts_resp = MagicMock(status_code=200)
        accounts_resp.json.return_value = {
            "value": [
                {
                    "id": f"/subscriptions/{_SUB}/resourceGroups/{_RG}/providers/Microsoft.NetApp/netAppAccounts/{_ACCOUNT}",
                    "name": _ACCOUNT,
                    "location": "eastus",
                }
            ]
        }
        pools_resp = MagicMock(status_code=200)
        pools_resp.json.return_value = {
            "value": [{"id": _POOL_ARM_ID, "properties": {"serviceLevel": "Premium"}}]
        }
        vols_resp = MagicMock(status_code=200)
        vols_resp.json.return_value = {"value": [{"id": _VOLUME_ARM_ID}]}
        mock_get.side_effect = [accounts_resp, pools_resp, vols_resp]

        contexts = client.list_volume_contexts()
        assert contexts[0]["volume_name"] == _VOL

        pool_resp = MagicMock(status_code=200)
        pool_resp.json.return_value = {"properties": {"serviceLevel": "Premium"}}
        mock_get.side_effect = [pool_resp]
        enriched = client.enrich_volumes_service_level(
            [{"volume_id": _VOLUME_ARM_ID, "pool_id": _POOL_ARM_ID}]
        )
        assert enriched[0]["service_level"] == "Premium"

    def test_list_volumes_full_resource_and_summary(self):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        ctx = {
            "subscription_id": _SUB,
            "resource_group": _RG,
            "netapp_account": _ACCOUNT,
            "pool_name": _POOL,
            "pool_id": _POOL_ARM_ID,
            "volume_name": _VOL,
            "volume_id": _VOLUME_ARM_ID,
        }
        with patch.object(client, "list_volume_contexts", return_value=[ctx]):
            summary = client.list_volumes()
            assert summary[0]["volume_name"] == _VOL
            with patch.object(
                client,
                "get_volume",
                return_value={"id": _VOLUME_ARM_ID, "properties": {}},
            ):
                full = client.list_volumes(full_resource=True)
            assert full[0]["id"] == _VOLUME_ARM_ID

    def test_pool_shrink_requires_allow_shrink(self):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client._azure_cred = azure_cred
        with patch.object(
            client,
            "_get",
            return_value={"properties": {"size": MIN_POOL_SIZE_BYTES * 2}},
        ):
            with pytest.raises(AnfValidationError, match="allow_shrink"):
                client.patch_capacity_pool_size(_POOL_ARM_ID, MIN_POOL_SIZE_BYTES)

    @patch("anf_common.client.requests.get")
    def test_http_error_on_500(self, mock_get):
        cred_dict = {"tenant_id": "t", "client_id": "c", "client_secret": "s"}
        azure_cred = MagicMock()
        azure_cred.get_token.return_value = MagicMock(token="tok")
        client = AnfClient(cred_dict, subscription_id=_SUB, region="eastus")
        client._azure_cred = azure_cred
        mock_get.return_value = MagicMock(status_code=500, text="boom")
        with pytest.raises(AnfHTTPError):
            client.get_volume(_VOLUME_ARM_ID)
