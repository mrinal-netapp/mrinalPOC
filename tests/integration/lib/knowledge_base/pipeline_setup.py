"""E2E pipelines: connector → dataset acquire → analytics → KB → search."""

from __future__ import annotations

import json
import os
import time

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.data_management.acquisition import acquire_until_ready
from lib.data_management.lifecycle import (
    assert_connector_connection as _assert_connector_connection,
    create_project as _create_project,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.object_store_client import (
    ObjectStoreTarget,
    object_store_from_s3_settings,
    seed_marker_object,
)
from lib.utils.sql_query import resolve_sql_query
from lib.utils.waits import (
    wait_for_dataset_ready,
    wait_for_kb_ready,
    wait_for_platform_project_ready,
    wait_for_workflow_terminal,
)


def _validate_search_preconditions(
    settings: IntegrationSettings,
    *,
    seed_marker: bool,
    search_query: str,
) -> None:
    if settings.skip_search:
        return
    if not seed_marker and not search_query:
        pytest.fail(
            "Set E2E_SEARCH_QUERY (or connector-specific *_E2E_SEARCH_QUERY) to text "
            "in your source data, enable INTEGRATION_SEED_*=1, or SKIP_SEARCH=1"
        )


def _resolve_object_store_search_marker(
    settings: IntegrationSettings,
    resources: PipelineResources,
    store: ObjectStoreTarget,
    run_id: int,
    *,
    seed_marker: bool,
    search_query: str,
) -> str:
    seeded = None
    if seed_marker:
        with allure.step("Seed S3 marker object (optional)"):
            try:
                seeded = seed_marker_object(store, settings, run_id=run_id)
                resources.seeded_s3_key = seeded.key
                resources.seeded_object_store_label = store.label
                print(
                    f"[pipeline] seeded s3://{store.bucket}/{seeded.key} "
                    f"marker={seeded.marker}"
                )
            except OSError as exc:
                print(f"[pipeline] S3 seed skipped (cannot reach store from test host): {exc}")
                if not search_query:
                    pytest.skip(
                        "Object seed failed and no E2E_SEARCH_QUERY — "
                        "set search query or fix object store connectivity"
                    )
    if search_query:
        return search_query
    if seeded:
        return seeded.marker
    pytest.fail("Set E2E_SEARCH_QUERY or enable INTEGRATION_SEED_*=1 for search assertions")


def _create_project(
    client: PlatformClient, resources: PipelineResources, *, label: str
) -> str:
    with allure.step("Create project"):
        project_name = unique_name(f"e2e-{label}")
        resp = client.config_post("api/v1/projects", {"name": project_name})
        assert resp.status_code == 201, resp.text
        project = resp.json()
        resources.project_id = project["id"]
        resources.project_home_dir = project.get("home_dir")
        allure.attach(
            resources.project_id,
            name="project_id",
            attachment_type=allure.attachment_type.TEXT,
        )
        print(f"\n[pipeline:{label}] project={resources.project_id} name={project_name}")
        prefix = client.project_prefix(resources.project_id)
    # project-init runs async after the 201; it registers the per-project Keycloak
    # resource + admin policy. Until that lands the gateway's UMA-RPT swap fails
    # closed with 502 on any /projects/:id/* call, so gate before the connector /
    # dataset / KB steps that follow (a 200 here implies the resource exists and
    # the caller holds a scope).
    with allure.step("Wait for project-init (models + Keycloak service account)"):
        wait_for_platform_project_ready(
            client,
            resources.project_id,
            timeout_sec=int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300"),
        )
    return prefix


def _assert_connector_connection(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    step_label: str = "connector",
) -> None:
    """
    Invoke the platform datasource connection test API (config GET + workflow POST).

    Same path as the GUI Test connection button — pytest does not open DB/S3 itself.
    """
    if settings.skip_connection_test:
        print("[pipeline] SKIP_CONNECTION_TEST=1 — connection test skipped")
        return

    assert resources.datasource_id

    with allure.step(f"Test {step_label} connection (datasource API)"):
        ds_resp, test_resp = client.datasource_connection_test(
            prefix, resources.datasource_id
        )
        assert ds_resp.status_code == 200, (
            f"GET datasource failed: HTTP {ds_resp.status_code} {ds_resp.text}"
        )
        body = ds_resp.json()
        if not body.get("connector_config") or not body.get("credential_id"):
            pytest.fail(
                "Datasource missing connector_config or credential_id — "
                "cannot run platform connection test"
            )
        assert test_resp.status_code == 200, (
            f"workflow connection test request failed: "
            f"HTTP {test_resp.status_code} {test_resp.text}"
        )
        workflow_id = test_resp.json()["workflowId"]
        try:
            wait_for_workflow_terminal(
                lambda: client.workflow_get(
                    f"api/v1/workflows/{workflow_id}/status"
                ),
                timeout_sec=settings.connection_test_timeout_sec,
            )
        except (AssertionError, TimeoutError) as exc:
            pytest.fail(
                f"Platform datasource connection test failed ({step_label}) "
                f"[datasource={resources.datasource_id}]: {exc}"
            )


def _acquire_dataset_and_analytics(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> tuple[str | None, str | None]:
    return acquire_until_ready(client, settings, resources, prefix, run_analytics=True)


def _create_kb_and_search(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    search_marker: str,
    *,
    text_columns: str = "",
) -> None:
    kb_body: dict = {
        "name": unique_name("e2e-kb"),
        "description": "pytest e2e KB",
        "sourceDataset": resources.dataset_id,
        "embeddingModel": settings.kb_embedding_model,
        "chunkSize": settings.kb_chunk_size,
        "vectorSize": settings.kb_vector_size,
        "chunkStrategy": "fixed",
        "chunkOverlap": 50,
        "indexingMode": "hybrid",
    }
    if text_columns:
        kb_body["textColumns"] = text_columns

    with allure.step("Create knowledge base"):
        kb_resp = client.config_post(f"{prefix}/knowledgebases", kb_body)
        assert kb_resp.status_code == 201, kb_resp.text
        kb_created = kb_resp.json()
        resources.knowledge_base_id = kb_created["id"]
        if kb_created.get("warning"):
            pytest.fail(f"KB created but workflow not started: {kb_created['warning']}")
        print(f"[pipeline] KB={resources.knowledge_base_id} workflow={kb_created.get('workflowId')}")

    with allure.step("Wait for knowledge base ready"):
        kb_ready = wait_for_kb_ready(
            lambda: client.config_get(
                f"{prefix}/knowledgebases/{resources.knowledge_base_id}"
            ),
            timeout_sec=settings.kb_timeout_sec,
            poll_interval_sec=settings.kb_poll_interval_sec,
        )
        print(f"[pipeline] KB ready status={kb_ready.get('status')}")

    with allure.step("KB metadata"):
        meta = client.kb_get(
            f"api/v1/projects/{resources.project_id}/knowledgebases/"
            f"{resources.knowledge_base_id}/metadata"
        )
        assert meta.status_code == 200, meta.text

    if settings.skip_search:
        print("[pipeline] SKIP_SEARCH=1 — retrieval search assertions skipped")
        return

    with allure.step("KB top-K search"):
        search = client.kb_post(
            f"api/v1/projects/{resources.project_id}/knowledgebases/"
            f"{resources.knowledge_base_id}/search",
            {
                "query": search_marker,
                "topK": settings.search_top_k,
                "minScore": 0.0,
                "searchMode": "hybrid",
            },
        )
        assert search.status_code == 200, search.text
        results = search.json().get("results") or []
        assert len(results) > 0, (
            f"expected search hits for query {search_marker!r}: {search.json()}"
        )
        allure.attach(
            json.dumps(results, indent=2),
            name="search_results",
            attachment_type=allure.attachment_type.JSON,
        )
        print(f"[pipeline] search query={search_marker!r} hit count={len(results)}")
        for i, hit in enumerate(results):
            text = (hit.get("text") or "")[:200]
            score = hit.get("score")
            print(f"[pipeline]   [{i + 1}] score={score} text={text!r}")


def run_object_store_kb_pipeline(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    store: ObjectStoreTarget,
    *,
    seed_marker: bool,
    search_query: str,
    build_kb: bool = True,
) -> tuple[str, str]:
    """S3-compatible store → unstructured dataset → analytics → (optional KB → search).

    Returns (prefix, search_marker). Set build_kb=False to stop at a ready
    dataset so callers can build multiple KBs with different configs on it.
    """
    _validate_search_preconditions(
        settings, seed_marker=seed_marker, search_query=search_query
    )
    run_id = int(time.time())
    prefix = _create_project(client, resources, label=store.label)
    search_marker = _resolve_object_store_search_marker(
        settings,
        resources,
        store,
        run_id,
        seed_marker=seed_marker,
        search_query=search_query,
    )

    with allure.step("Create S3-compatible credential"):
        cred_resp = client.config_post(
            f"{prefix}/credentials",
            {
                "name": unique_name(f"e2e-{store.label}-cred"),
                "description": f"pytest {store.label}",
                "provider": "s3",
                "secretData": {
                    "access_key_id": store.access_key_id,
                    "secret_access_key": store.secret_access_key,
                },
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        resources.credential_id = cred_resp.json()["id"]

    connector_config = {
        "scope": "resource",
        "provider": "s3",
        "connector_type": "objectstore",
        "bucket": store.bucket,
        "prefix": store.prefix,
        "endpoint": store.endpoint,
        "region": store.region,
    }

    with allure.step("Create S3-compatible connector datasource"):
        conn_resp = client.config_post(
            f"{prefix}/datasources",
            {
                "name": unique_name(f"e2e-{store.label}-connector"),
                "type": "connector",
                "description": f"pytest {store.label} connector",
                "connector_config": connector_config,
                "credential_id": resources.credential_id,
            },
        )
        assert conn_resp.status_code == 201, conn_resp.text
        resources.datasource_id = conn_resp.json()["id"]

    _assert_connector_connection(
        client,
        settings,
        resources,
        prefix,
        step_label="S3-compatible",
    )

    with allure.step("Create dataset"):
        selector = [{"bucket": store.bucket}]
        if store.prefix:
            selector[0]["prefix"] = store.prefix
        dataset_resp = client.config_post(
            f"{prefix}/datasets",
            {
                "name": unique_name(f"e2e-{store.label}-dataset"),
                "description": f"pytest {store.label} acquired dataset",
                "type": "acquired",
                "kind": "unstructured",
                "originConnector": resources.datasource_id,
                "resourceSelector": selector,
                "acquisitionConfig": {"writeMode": "append", "fileGlob": "*"},
            },
        )
        assert dataset_resp.status_code == 201, dataset_resp.text
        resources.dataset_id = dataset_resp.json()["id"]

    _acquire_dataset_and_analytics(client, settings, resources, prefix)
    if build_kb:
        _create_kb_and_search(client, settings, resources, prefix, search_marker)
    return prefix, search_marker


def run_s3compatible_kb_pipeline_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    """S3-compatible object store (MinIO, s3gateway, …) → KB → search."""
    store = object_store_from_s3_settings(settings)
    run_object_store_kb_pipeline(
        client,
        settings,
        resources,
        store,
        seed_marker=settings.seed_s3_marker,
        search_query=settings.resolved_s3compatible_search_query(),
    )


def setup_s3compatible_ready_dataset(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> tuple[str, str]:
    """S3/MinIO → ready unstructured dataset (no KB). Returns (prefix, search_marker).

    Lets a test build several KBs with different configs on one dataset.
    """
    store = object_store_from_s3_settings(settings)
    return run_object_store_kb_pipeline(
        client,
        settings,
        resources,
        store,
        seed_marker=settings.seed_s3_marker,
        search_query=settings.resolved_s3compatible_search_query(),
        build_kb=False,
    )


def _run_database_kb_pipeline(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    *,
    label: str,
    provider: str,
    database_type: str,
    host: str,
    port: int,
    database: str,
    schema: str,
    ssl_mode: str,
    username: str,
    password: str,
    sql_query: str,
    source_table: str,
    search_query: str,
    kb_text_columns: str,
    kb_text_columns_env: str,
) -> None:
    """Structured DB connector → dataset → analytics → KB → search."""
    _validate_search_preconditions(
        settings, seed_marker=False, search_query=search_query
    )
    if not settings.skip_search and not kb_text_columns:
        pytest.fail(
            f"{kb_text_columns_env} is required for structured KB indexing "
            "(comma-separated column names containing searchable text)"
        )

    prefix = _create_project(client, resources, label=label)
    display = label.capitalize()

    with allure.step(f"Create {display} credential"):
        cred_resp = client.config_post(
            f"{prefix}/credentials",
            {
                "name": unique_name(f"e2e-{label}-cred"),
                "description": f"pytest {display}",
                "provider": provider,
                "secretData": {"username": username, "password": password},
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        resources.credential_id = cred_resp.json()["id"]

    connector_config = {
        "scope": "resource",
        "provider": provider,
        "connector_type": "database",
        "database_type": database_type,
        "host": host,
        "port": port,
        "database": database,
        "schema": schema,
        "ssl_mode": ssl_mode,
    }

    with allure.step(f"Create {display} connector datasource"):
        conn_resp = client.config_post(
            f"{prefix}/datasources",
            {
                "name": unique_name(f"e2e-{label}-connector"),
                "type": "connector",
                "description": f"pytest {display} connector",
                "connector_config": connector_config,
                "credential_id": resources.credential_id,
            },
        )
        assert conn_resp.status_code == 201, conn_resp.text
        resources.datasource_id = conn_resp.json()["id"]

    _assert_connector_connection(
        client,
        settings,
        resources,
        prefix,
        step_label=display,
    )

    formatted_sql = resolve_sql_query(
        provider,
        sql_query,
        database,
        schema,
        source_table,
    )
    allure.attach(
        formatted_sql,
        name="sqlQuery",
        attachment_type=allure.attachment_type.TEXT,
    )

    with allure.step("Create structured dataset"):
        dataset_resp = client.config_post(
            f"{prefix}/datasets",
            {
                "name": unique_name(f"e2e-{label}-dataset"),
                "description": f"pytest {display} acquired dataset",
                "type": "acquired",
                "kind": "structured",
                "originConnector": resources.datasource_id,
                "sqlQuery": formatted_sql,
                "sourceDatabase": database,
                "sourceSchema": schema,
                "resourceSelector": [
                    {"database": database, "schema": schema, "table": source_table}
                ],
            },
        )
        assert dataset_resp.status_code == 201, dataset_resp.text
        resources.dataset_id = dataset_resp.json()["id"]

    _acquire_dataset_and_analytics(client, settings, resources, prefix)
    _create_kb_and_search(
        client,
        settings,
        resources,
        prefix,
        search_query,
        text_columns=kb_text_columns,
    )


def run_postgres_kb_pipeline_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    settings.require_postgres()
    _run_database_kb_pipeline(
        client,
        settings,
        resources,
        label="postgres",
        provider="postgresql",
        database_type="postgresql",
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_database,
        schema=settings.postgres_schema,
        ssl_mode=settings.postgres_ssl_mode,
        username=settings.postgres_username,
        password=settings.postgres_password,
        sql_query=settings.postgres_sql_query,
        source_table=settings.postgres_source_table,
        search_query=settings.resolved_postgres_search_query(),
        kb_text_columns=settings.postgres_kb_text_columns,
        kb_text_columns_env="POSTGRES_KB_TEXT_COLUMNS",
    )


def run_mysql_kb_pipeline_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    settings.require_mysql()
    _run_database_kb_pipeline(
        client,
        settings,
        resources,
        label="mysql",
        provider="mysql",
        database_type="mysql",
        host=settings.mysql_host,
        port=settings.mysql_port,
        database=settings.mysql_database,
        schema=settings.mysql_schema,
        ssl_mode=settings.mysql_ssl_mode,
        username=settings.mysql_username,
        password=settings.mysql_password,
        sql_query=settings.mysql_sql_query,
        source_table=settings.mysql_source_table,
        search_query=settings.resolved_mysql_search_query(),
        kb_text_columns=settings.mysql_kb_text_columns,
        kb_text_columns_env="MYSQL_KB_TEXT_COLUMNS",
    )


def run_gcp_metrics_acquisition_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    """
    GCP (GCNV) metrics connector -> structured dataset -> acquisition -> analytics.
    """
    settings.require_gcp_metrics()
    prefix = _create_project(client, resources, label="gcp-metrics")

    with allure.step("Create GCP credential"):
        cred_resp = client.config_post(
            f"{prefix}/credentials",
            {
                "name": unique_name("e2e-gcp-cred"),
                "description": "pytest GCP credential",
                "provider": "gcp",
                "secretData": {
                    "service_account_json": settings.gcp_service_account_json,
                },
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        resources.credential_id = cred_resp.json()["id"]

    connector_config = {
        "scope": "account",
        "provider": "gcp",
        "connector_type": "cloud",
        "project_id": settings.gcp_project_id,
        "default_region": settings.gcp_default_region,
    }
    with allure.step("Create GCP metrics connector datasource"):
        conn_resp = client.config_post(
            f"{prefix}/datasources",
            {
                "name": unique_name("e2e-gcp-connector"),
                "type": "connector",
                "description": "pytest GCP metrics connector",
                "connector_config": connector_config,
                "credential_id": resources.credential_id,
            },
        )
        assert conn_resp.status_code == 201, conn_resp.text
        resources.datasource_id = conn_resp.json()["id"]

    _assert_connector_connection(
        client,
        settings,
        resources,
        prefix,
        step_label="GCP metrics",
    )

    with allure.step("Create GCP metrics dataset"):
        dataset_resp = client.config_post(
            f"{prefix}/datasets",
            {
                "name": unique_name("e2e-gcp-metrics-dataset"),
                "description": "pytest GCP acquired metrics dataset",
                "type": "acquired",
                "kind": "structured",
                "originConnector": resources.datasource_id,
                "resourceSelector": [
                    {"category": "volume_metrics"},
                    {"category": "pool_metrics"},
                    {"category": "volume_tier_metrics"},
                ],
                "acquisitionConfig": {"writeMode": "append"},
            },
        )
        assert dataset_resp.status_code == 201, dataset_resp.text
        resources.dataset_id = dataset_resp.json()["id"]

    _acquire_dataset_and_analytics(client, settings, resources, prefix)


def run_ontap_metrics_acquisition_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> tuple[str | None, str | None]:
    """
    ONTAP metrics connector -> structured dataset -> acquisition -> analytics.
    """
    settings.require_ontap_metrics()
    prefix = _create_project(client, resources, label="ontap-metrics")

    with allure.step("Create ONTAP credential"):
        cred_resp = client.config_post(
            f"{prefix}/credentials",
            {
                "name": unique_name("e2e-ontap-cred"),
                "description": "pytest ONTAP credential",
                "provider": "ontap",
                "secretData": {
                    "username": settings.ontap_username,
                    "password": settings.ontap_password,
                },
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        resources.credential_id = cred_resp.json()["id"]

    connector_config = {
        "scope": "account",
        "provider": "ontap",
        "connector_type": "storage",
        "cluster_url": settings.ontap_cluster_url,
        "verify_tls": settings.ontap_verify_tls,
    }
    if settings.ontap_default_svm:
        connector_config["default_svm"] = settings.ontap_default_svm

    with allure.step("Create ONTAP metrics connector datasource"):
        conn_resp = client.config_post(
            f"{prefix}/datasources",
            {
                "name": unique_name("e2e-ontap-connector"),
                "type": "connector",
                "description": "pytest ONTAP metrics connector",
                "connector_config": connector_config,
                "credential_id": resources.credential_id,
            },
        )
        assert conn_resp.status_code == 201, conn_resp.text
        resources.datasource_id = conn_resp.json()["id"]

    _assert_connector_connection(
        client,
        settings,
        resources,
        prefix,
        step_label="ONTAP metrics",
    )

    with allure.step("Create ONTAP metrics dataset"):
        dataset_resp = client.config_post(
            f"{prefix}/datasets",
            {
                "name": unique_name("e2e-ontap-metrics-dataset"),
                "description": "pytest ONTAP acquired metrics dataset",
                "type": "acquired",
                "kind": "structured",
                "originConnector": resources.datasource_id,
                "resourceSelector": [
                    {"category": "volume_metrics"},
                    {"category": "aggregate_metrics"},
                    {"category": "quota_metrics"},
                ],
                "acquisitionConfig": {"writeMode": "append"},
            },
        )
        assert dataset_resp.status_code == 201, dataset_resp.text
        resources.dataset_id = dataset_resp.json()["id"]

    return _acquire_dataset_and_analytics(client, settings, resources, prefix)
