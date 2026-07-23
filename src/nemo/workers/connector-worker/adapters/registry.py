"""Provider registry: maps provider id to adapter instance."""
from observability_client_runtime import get_logger
from typing import Dict, Optional

from .base import ProviderAdapter

logger = get_logger()

_registry: Dict[str, ProviderAdapter] = {}


def register(provider_id: str, adapter: ProviderAdapter) -> None:
    logger.info("Registering provider adapter: %s", provider_id)
    _registry[provider_id] = adapter


def get(provider_id: str) -> Optional[ProviderAdapter]:
    return _registry.get(provider_id)


def list_providers() -> list:
    return list(_registry.keys())


def _register_builtins() -> None:
    from .s3_adapter import S3Adapter
    from .postgresql_adapter import PostgreSQLAdapter
    from .mysql_adapter import MySQLAdapter
    from .gcp_adapter import GCPAdapter
    from .gcs_adapter import GCSAdapter
    from .ontap_adapter import OntapAdapter
    from .redash_adapter import RedashAdapter
    from .azure_adapter import AzureAdapter

    register("s3", S3Adapter())
    register("gcs", GCSAdapter())
    register("postgresql", PostgreSQLAdapter())
    register("mysql", MySQLAdapter())
    register("gcp", GCPAdapter())
    register("ontap", OntapAdapter())
    register("redash", RedashAdapter())
    register("azure_cloud", AzureAdapter())


_register_builtins()
