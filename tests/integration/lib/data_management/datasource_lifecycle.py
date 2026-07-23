"""Reusable datasource lifecycle runner for connector and volume providers."""

from __future__ import annotations

import allure

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.builders import datasource_connector_body, volume_datasource_body
from lib.data_management.lifecycle import (
    assert_connector_connection,
    create_datasource_and_store,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.object_store_client import ObjectStoreTarget


def run_connector_datasource_lifecycle(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    provider: str,
    *,
    label: str | None = None,
    store: ObjectStoreTarget | None = None,
) -> None:
    """Exercise datasource CRUD for a connector provider.

    Requires ``dm_credential_prereq`` (project + credential on ``resources``).
    """
    assert resources.credential_id, "credential prerequisite missing"
    label = label or provider

    ds_body = datasource_connector_body(
        settings,
        provider,
        resources.credential_id,
        label=label,
        store=store,
    )
    create_datasource_and_store(
        client, resources, prefix, ds_body, step_label=f"{label} datasource"
    )

    with allure.step("GET datasource"):
        get_resp = client.get_datasource(prefix, resources.datasource_id)
        assert get_resp.status_code == 200, get_resp.text
        assert get_resp.json().get("credential_id") == resources.credential_id

    assert_connector_connection(
        client, settings, resources, prefix, step_label=label
    )

    with allure.step("PUT datasource (description patch)"):
        put_resp = client.put_datasource(
            prefix,
            resources.datasource_id,
            {
                "name": ds_body["name"],
                "type": "connector",
                "description": f"updated pytest {label}",
                "connector_config": ds_body["connector_config"],
                "credential_id": resources.credential_id,
            },
        )
        assert put_resp.status_code == 200, put_resp.text

    with allure.step("GET datasource history"):
        hist = client.get_datasource_history(prefix, resources.datasource_id)
        assert hist.status_code == 200, hist.text

    with allure.step("LIST datasources"):
        listed = client.list_datasources(prefix)
        assert listed.status_code == 200, listed.text
        ids = [d.get("id") for d in listed.json()]
        assert resources.datasource_id in ids

    with allure.step("DELETE datasource"):
        del_resp = client.delete_datasource(prefix, resources.datasource_id)
        assert del_resp.status_code in (200, 204), del_resp.text
        resources.datasource_id = None


def run_s3_datasource_lifecycle(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    store: ObjectStoreTarget | None = None,
) -> None:
    from lib.utils.object_store_client import object_store_from_s3_settings

    if store is None:
        store = object_store_from_s3_settings(settings)
    run_connector_datasource_lifecycle(
        client, settings, resources, prefix, "s3", label="s3", store=store
    )


def run_volume_datasource_lifecycle(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> None:
    """Volume datasource lifecycle including optional scan trigger.

    Requires ``dm_project_prereq`` only (no credential).
    """
    ds_body = volume_datasource_body(settings)
    create_datasource_and_store(
        client, resources, prefix, ds_body, step_label="volume datasource"
    )

    with allure.step("GET volume datasource"):
        get_resp = client.get_datasource(prefix, resources.datasource_id)
        assert get_resp.status_code == 200, get_resp.text
        assert get_resp.json().get("type") == "volume"

    if settings.volume_scan_config():
        with allure.step("POST volume scan"):
            scan = client.scan_datasource(prefix, resources.datasource_id)
            assert scan.status_code in (200, 202), scan.text

    with allure.step("DELETE volume datasource"):
        del_resp = client.delete_datasource(prefix, resources.datasource_id)
        assert del_resp.status_code in (200, 204), del_resp.text
        resources.datasource_id = None
