"""Dataset lifecycle runners (acquired + manual) without KB."""

from __future__ import annotations

import allure

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.acquisition import acquire_until_ready, import_until_ready
from lib.data_management.builders import (
    acquired_metrics_dataset_body,
    acquired_structured_dataset_body,
    acquired_unstructured_dataset_body,
    manual_unstructured_dataset_body,
)
from lib.data_management.lifecycle import create_dataset_and_store
from lib.data_management.manual_upload import (
    register_uploaded_files,
    resolve_manual_upload_payload,
    upload_manual_file,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.object_store_client import object_store_from_s3_settings, seed_marker_object
from lib.utils.sql_query import resolve_sql_query


def run_acquired_structured_dataset(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    provider: str,
    label: str,
) -> None:
    """Postgres or MySQL structured acquired dataset through ready (no KB).

    Requires ``dm_datasource_prereq`` (project + credential + datasource).
    """
    assert resources.datasource_id, "datasource prerequisite missing"

    if provider == "postgresql":
        database = settings.postgres_database
        schema = settings.postgres_schema
        source_table = settings.postgres_source_table
        sql_query = settings.postgres_sql_query
    else:
        database = settings.mysql_database
        schema = settings.mysql_schema or settings.mysql_database
        source_table = settings.mysql_source_table
        sql_query = settings.mysql_sql_query

    formatted_sql = resolve_sql_query(
        provider, sql_query, database, schema, source_table
    )
    allure.attach(
        formatted_sql, name="sqlQuery", attachment_type=allure.attachment_type.TEXT
    )

    dataset_body = acquired_structured_dataset_body(
        label=label,
        datasource_id=resources.datasource_id,
        database=database,
        schema=schema,
        source_table=source_table,
        sql_query=formatted_sql,
    )
    create_dataset_and_store(client, resources, prefix, dataset_body)
    acquire_until_ready(
        client,
        settings,
        resources,
        prefix,
        analytics_kind="structured",
        min_preview_rows=1,
    )

    with allure.step("GET dataset facets (smoke)"):
        facets = client.config_get(
            f"{prefix}/datasets/{resources.dataset_id}/facets"
        )
        assert facets.status_code == 200, facets.text


def run_acquired_unstructured_dataset(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> None:
    """S3 unstructured acquired dataset through ready.

    Requires ``dm_datasource_prereq`` for provider ``s3``.
    """
    assert resources.datasource_id, "datasource prerequisite missing"
    store = object_store_from_s3_settings(settings)

    if settings.seed_s3_marker:
        with allure.step("Seed S3 marker object for acquisition"):
            seeded = seed_marker_object(store, settings)
            resources.seeded_s3_key = seeded.key
            resources.seeded_object_store_label = store.label

    dataset_body = acquired_unstructured_dataset_body(
        label="s3",
        datasource_id=resources.datasource_id,
        bucket=store.bucket,
        prefix=store.prefix,
    )
    create_dataset_and_store(client, resources, prefix, dataset_body)
    acquire_until_ready(
        client,
        settings,
        resources,
        prefix,
        analytics_kind="basic",
    )


def run_metrics_dataset(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    provider: str,
    label: str,
    categories: list[str],
) -> None:
    """Metrics acquired dataset through ready with analytics query validation.

    Requires ``dm_datasource_prereq`` for the metrics provider.
    """
    assert resources.datasource_id, "datasource prerequisite missing"

    dataset_body = acquired_metrics_dataset_body(
        label=label,
        datasource_id=resources.datasource_id,
        categories=categories,
    )
    create_dataset_and_store(client, resources, prefix, dataset_body)
    acquire_until_ready(
        client,
        settings,
        resources,
        prefix,
        analytics_kind="metrics",
        metrics_provider=provider,
        categories=categories,
        min_preview_rows=0,
    )


def run_manual_unstructured_upload(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    file_name: str | None = None,
    file_content: bytes | None = None,
    content_type: str | None = None,
) -> None:
    """Manual unstructured upload → register → import → ready.

    Requires ``dm_project_prereq`` only.

    When ``file_name`` / ``file_content`` are omitted, uses
    ``MANUAL_UPLOAD_FILE_PATH`` from settings (or the built-in synthetic file).
    """
    assert resources.project_id, "project prerequisite missing"

    if file_name is None and file_content is None and content_type is None:
        resolved_name, resolved_content, resolved_type = resolve_manual_upload_payload(
            settings
        )
    else:
        default_name, default_content, default_type = resolve_manual_upload_payload(
            settings
        )
        resolved_name = file_name if file_name is not None else default_name
        resolved_content = file_content if file_content is not None else default_content
        resolved_type = content_type if content_type is not None else default_type

    dataset_body = manual_unstructured_dataset_body()
    create_dataset_and_store(client, resources, prefix, dataset_body)

    uploaded = upload_manual_file(
        client,
        project_home_dir=resources.project_home_dir,
        dataset_id=resources.dataset_id,
        relative_path=resolved_name,
        content=resolved_content,
        content_type=resolved_type,
    )

    reg = register_uploaded_files(
        client, prefix, resources.dataset_id, [uploaded]
    )
    assert reg.status_code == 200, reg.text

    import_until_ready(client, settings, resources, prefix)
