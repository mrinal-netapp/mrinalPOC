"""Credential CRUD and dependency enforcement against a live deployment."""

from __future__ import annotations

from dataclasses import dataclass

import allure
import pytest

from lib.common.auth import KeycloakAuth
from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.data_management.builders import (
    credential_for_provider,
    datasource_connector_body,
)
from lib.data_management.lifecycle import reconcile_reference_edges
from lib.data_management.prerequisites import (
    resolve_primary_provider,
    setup_project_prerequisite,
)
from lib.utils.cleanup import PipelineResources, cleanup_pipeline
from lib.utils.dependents import dependents_count

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.credential,
]


@dataclass
class CredentialLifecycleContext:
    client: PlatformClient
    settings: IntegrationSettings
    resources: PipelineResources
    prefix: str = ""
    credential_id: str = ""
    credential_name: str = ""
    datasource_id: str = ""
    provider: str = "postgresql"


@pytest.fixture(scope="class")
def credential_ctx(
    integration_settings: IntegrationSettings,
    keycloak_auth: KeycloakAuth,
    request: pytest.FixtureRequest,
) -> CredentialLifecycleContext:
    """Project RBAC prerequisite + isolated resources for credential CRUD tests."""
    client = PlatformClient(integration_settings, keycloak_auth)
    resources = PipelineResources()

    def _teardown() -> None:
        cleanup_pipeline(client, integration_settings, resources)
        client.close()

    request.addfinalizer(_teardown)

    provider = resolve_primary_provider(integration_settings)
    if not provider:
        pytest.skip(
            "Credential lifecycle skipped — set POSTGRES_*, S3_*, or ONTAP_* in .env.local"
        )

    prefix = setup_project_prerequisite(
        client,
        integration_settings,
        resources,
        label="credential-lifecycle",
        metadata={"source": "pytest-data-management"},
    )

    return CredentialLifecycleContext(
        client=client,
        settings=integration_settings,
        resources=resources,
        prefix=prefix,
        provider=provider,
    )


class TestCredentialLifecycle:
    """Credential lifecycle — project is a prerequisite fixture, not a test."""

    @pytest.mark.smoke
    def test_create_credential(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        body = credential_for_provider(ctx.settings, ctx.provider, label="cred-lc")
        ctx.credential_name = body["name"]
        resp = ctx.client.create_credential(ctx.prefix, body)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.credential_id = data["id"]
        ctx.resources.credential_id = ctx.credential_id
        assert data.get("secretData") is None

    def test_list_credentials(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("no credential")
        resp = ctx.client.list_credentials(ctx.prefix)
        assert resp.status_code == 200, resp.text
        rows = resp.json()
        assert any(r.get("id") == ctx.credential_id for r in rows)
        assert rows[0].get("dependentsSummary") is not None

    def test_get_credential(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("no credential")
        resp = ctx.client.get_credential(ctx.prefix, ctx.credential_id)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("provider") == ctx.provider

    def test_patch_credential(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("no credential")
        new_name = unique_name("e2e-cred-patched")
        resp = ctx.client.patch_credential(
            ctx.prefix, ctx.credential_id, {"name": new_name}
        )
        assert resp.status_code == 200, resp.text
        ctx.credential_name = new_name

    def test_validate_credential(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("no credential")
        if ctx.settings.skip_connection_test:
            pytest.skip("SKIP_CONNECTION_TEST=1")
        resp = ctx.client.validate_credential(ctx.prefix, ctx.credential_id)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("valid") is True

    def test_dependents_empty(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("no credential")
        resp = ctx.client.credential_dependents(ctx.prefix, ctx.credential_id)
        assert resp.status_code == 200, resp.text
        assert dependents_count(resp.json()) == 0

    def test_create_datasource_bound(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("no credential")
        store = None
        if ctx.provider == "s3":
            from lib.utils.object_store_client import object_store_from_s3_settings

            store = object_store_from_s3_settings(ctx.settings)
        ds_body = datasource_connector_body(
            ctx.settings,
            ctx.provider,
            ctx.credential_id,
            label="cred-lc",
            store=store,
        )
        resp = ctx.client.create_datasource(ctx.prefix, ds_body)
        assert resp.status_code == 201, resp.text
        ctx.datasource_id = resp.json()["id"]
        ctx.resources.datasource_id = ctx.datasource_id
        reconcile_reference_edges(ctx.client, ctx.resources.project_id)

    def test_dependents_nonempty(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id or not ctx.datasource_id:
            pytest.skip("no datasource bound")
        resp = ctx.client.credential_dependents(ctx.prefix, ctx.credential_id)
        assert resp.status_code == 200, resp.text
        assert dependents_count(resp.json()) >= 1

    def test_delete_credential_blocked(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id or not ctx.datasource_id:
            pytest.skip("no bound datasource")
        resp = ctx.client.delete_credential(ctx.prefix, ctx.credential_id)
        assert resp.status_code == 409, resp.text

    def test_delete_datasource_then_credential(
        self, credential_ctx: CredentialLifecycleContext
    ) -> None:
        ctx = credential_ctx
        if not ctx.datasource_id:
            pytest.skip("no datasource")
        del_ds = ctx.client.delete_datasource(ctx.prefix, ctx.datasource_id)
        assert del_ds.status_code in (200, 204), del_ds.text
        ctx.resources.datasource_id = None
        ctx.datasource_id = ""

        del_cred = ctx.client.delete_credential(ctx.prefix, ctx.credential_id)
        assert del_cred.status_code in (200, 204), del_cred.text
        ctx.resources.credential_id = None

    def test_get_deleted_404(self, credential_ctx: CredentialLifecycleContext) -> None:
        ctx = credential_ctx
        if not ctx.credential_id:
            pytest.skip("credential already deleted")
        resp = ctx.client.get_credential(ctx.prefix, ctx.credential_id)
        assert resp.status_code == 404, resp.text
