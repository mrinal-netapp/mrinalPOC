"""Request-body builders for credential / datasource / dataset APIs."""

from __future__ import annotations

from typing import Any

from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.object_store_client import ObjectStoreTarget


def credential_body(
    *,
    name: str,
    provider: str,
    secret_data: dict[str, Any],
    description: str = "",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": name,
        "provider": provider,
        "secretData": secret_data,
    }
    if description:
        body["description"] = description
    return body


def credential_for_provider(
    settings: IntegrationSettings,
    provider: str,
    *,
    label: str,
) -> dict[str, Any]:
    """Build a create-credential body for the given provider using env settings."""
    name = unique_name(f"e2e-{label}-cred")
    if provider == "postgresql":
        return credential_body(
            name=name,
            provider="postgresql",
            description=f"pytest {label}",
            secret_data={
                "username": settings.postgres_username,
                "password": settings.postgres_password,
            },
        )
    if provider == "mysql":
        return credential_body(
            name=name,
            provider="mysql",
            description=f"pytest {label}",
            secret_data={
                "username": settings.mysql_username,
                "password": settings.mysql_password,
            },
        )
    if provider == "s3":
        return credential_body(
            name=name,
            provider="s3",
            description=f"pytest {label}",
            secret_data={
                "access_key_id": settings.aws_access_key_id,
                "secret_access_key": settings.aws_secret_access_key,
            },
        )
    if provider == "gcp":
        return credential_body(
            name=name,
            provider="gcp",
            description="pytest GCP credential",
            secret_data={"service_account_json": settings.gcp_service_account_json},
        )
    if provider == "azure_cloud":
        return credential_body(
            name=name,
            provider="azure_cloud",
            description="pytest Azure credential",
            secret_data={
                "tenant_id": settings.azure_tenant_id,
                "client_id": settings.azure_client_id,
                "client_secret": settings.azure_client_secret,
            },
        )
    if provider == "ontap":
        return credential_body(
            name=name,
            provider="ontap",
            description="pytest ONTAP credential",
            secret_data={
                "username": settings.ontap_username,
                "password": settings.ontap_password,
            },
        )
    if provider == "redash":
        return credential_body(
            name=name,
            provider="redash",
            description="pytest Redash credential",
            secret_data={"api_key": settings.redash_api_key},
        )
    raise ValueError(f"unsupported credential provider: {provider}")


def connector_config_for_provider(
    settings: IntegrationSettings,
    provider: str,
    store: ObjectStoreTarget | None = None,
) -> dict[str, Any]:
    if provider == "postgresql":
        return {
            "scope": "resource",
            "provider": "postgresql",
            "connector_type": "database",
            "database_type": "postgresql",
            "host": settings.postgres_host,
            "port": settings.postgres_port,
            "database": settings.postgres_database,
            "schema": settings.postgres_schema,
            "ssl_mode": settings.postgres_ssl_mode,
        }
    if provider == "mysql":
        return {
            "scope": "resource",
            "provider": "mysql",
            "connector_type": "database",
            "database_type": "mysql",
            "host": settings.mysql_host,
            "port": settings.mysql_port,
            "database": settings.mysql_database,
            "schema": settings.mysql_schema or settings.mysql_database,
            "ssl_mode": settings.mysql_ssl_mode,
        }
    if provider == "s3":
        if store is None:
            raise ValueError("s3 connector_config requires ObjectStoreTarget")
        return {
            "scope": "resource",
            "provider": "s3",
            "connector_type": "objectstore",
            "bucket": store.bucket,
            "prefix": store.prefix,
            "endpoint": store.endpoint,
            "region": store.region,
        }
    if provider == "gcp":
        return {
            "scope": "account",
            "provider": "gcp",
            "connector_type": "cloud",
            "project_id": settings.gcp_project_id,
            "default_region": settings.gcp_default_region,
        }
    if provider == "azure_cloud":
        cfg: dict[str, Any] = {
            "scope": "account",
            "provider": "azure_cloud",
            "connector_type": "cloud",
            "subscription_id": settings.azure_subscription_id,
            "default_region": settings.azure_default_region,
        }
        if settings.azure_resource_group:
            cfg["resource_group"] = settings.azure_resource_group
        return cfg
    if provider == "ontap":
        cfg = {
            "scope": "account",
            "provider": "ontap",
            "connector_type": "storage",
            "cluster_url": settings.ontap_cluster_url,
            "verify_tls": settings.ontap_verify_tls,
        }
        if settings.ontap_default_svm:
            cfg["default_svm"] = settings.ontap_default_svm
        return cfg
    if provider == "redash":
        return {
            "scope": "account",
            "provider": "redash",
            "connector_type": "api",
            "base_url": settings.redash_url.rstrip("/"),
            "verify_tls": settings.redash_verify_tls,
        }
    raise ValueError(f"unsupported connector provider: {provider}")


def datasource_connector_body(
    settings: IntegrationSettings,
    provider: str,
    credential_id: str,
    *,
    label: str,
    store: ObjectStoreTarget | None = None,
) -> dict[str, Any]:
    return {
        "name": unique_name(f"e2e-{label}-connector"),
        "type": "connector",
        "description": f"pytest {label} connector",
        "connector_config": connector_config_for_provider(settings, provider, store),
        "credential_id": credential_id,
    }


def volume_datasource_body(settings: IntegrationSettings) -> dict[str, Any]:
    return {
        "name": unique_name("e2e-volume-ds"),
        "type": "volume",
        "description": "pytest volume datasource",
        "volume_config": {
            "region": settings.volume_region,
            "volume_info": {
                "type": "nfs",
                "endpoint": settings.volume_endpoint,
                "mount_options": settings.volume_mount_options,
                "provisioning_mode": "static",
            },
            "auth_info": settings.volume_auth_info(),
            "protocol": settings.volume_protocol,
        },
        "scan_config": settings.volume_scan_config(),
    }


def acquired_structured_dataset_body(
    *,
    label: str,
    datasource_id: str,
    database: str,
    schema: str,
    source_table: str,
    sql_query: str,
) -> dict[str, Any]:
    return {
        "name": unique_name(f"e2e-{label}-dataset"),
        "description": f"pytest {label} acquired structured dataset",
        "type": "acquired",
        "kind": "structured",
        "originConnector": datasource_id,
        "sqlQuery": sql_query,
        "sourceDatabase": database,
        "sourceSchema": schema,
        "resourceSelector": [
            {"database": database, "schema": schema, "table": source_table}
        ],
    }


def acquired_unstructured_dataset_body(
    *,
    label: str,
    datasource_id: str,
    bucket: str,
    prefix: str = "",
) -> dict[str, Any]:
    selector: dict[str, str] = {"bucket": bucket}
    if prefix:
        selector["prefix"] = prefix
    return {
        "name": unique_name(f"e2e-{label}-dataset"),
        "description": f"pytest {label} acquired unstructured dataset",
        "type": "acquired",
        "kind": "unstructured",
        "originConnector": datasource_id,
        "resourceSelector": [selector],
        "acquisitionConfig": {"writeMode": "append", "fileGlob": "*"},
    }


def acquired_metrics_dataset_body(
    *,
    label: str,
    datasource_id: str,
    categories: list[str],
) -> dict[str, Any]:
    return {
        "name": unique_name(f"e2e-{label}-metrics-dataset"),
        "description": f"pytest {label} acquired metrics dataset",
        "type": "acquired",
        "kind": "structured",
        "originConnector": datasource_id,
        "resourceSelector": [{"category": c} for c in categories],
        "acquisitionConfig": {"writeMode": "append"},
    }


def manual_unstructured_dataset_body(*, label: str = "manual") -> dict[str, Any]:
    return {
        "name": unique_name(f"e2e-{label}-manual-dataset"),
        "description": "pytest manual unstructured dataset",
        "type": "manual",
        "kind": "unstructured",
    }
