"""Load integration test configuration from tests/integration/.env.local."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

INTEGRATION_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = INTEGRATION_ROOT / ".env.local"


def _strip(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().strip('"').strip("'")


def _derive_token_url(api_base_url: str, realm: str = "nemo") -> str:
    """Derive the Keycloak token URL from API_BASE_URL (app.<host> -> auth.<host>)."""
    parts = urlsplit(api_base_url)
    if not parts.scheme or not parts.netloc or not parts.netloc.startswith("app."):
        return ""
    auth_host = "auth." + parts.netloc[len("app.") :]
    path = f"/realms/{realm}/protocol/openid-connect/token"
    return urlunsplit((parts.scheme, auth_host, path, "", ""))


def _env_sql(value: str | None) -> str:
    """SQL from .env (optional); allow \\n for single-line .env files."""
    text = _strip(value)
    if not text:
        return ""
    return text.replace("\\n", "\n")


def _flag(name: str, default: bool = False) -> bool:
    val = _strip(os.environ.get(name))
    if not val:
        return default
    if val in ("0", "false", "no", "off"):
        return False
    return val in ("1", "true", "yes", "on")


def _file_text(path_value: str) -> str:
    path = Path(path_value).expanduser()
    if not path.is_absolute():
        path = INTEGRATION_ROOT / path
    if not path.is_file():
        raise ValueError(f"GCP service-account file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def _resolve_gcp_service_account_json() -> str:
    # Prefer inline JSON (e.g. a GitHub secret passed straight into the
    # container env) so the credential never has to be written to disk; fall
    # back to the file path for local runs.
    inline = _strip(os.environ.get("GCP_SERVICE_ACCOUNT_JSON"))
    if inline:
        return inline
    json_file = _strip(os.environ.get("GCP_SERVICE_ACCOUNT_JSON_FILE"))
    if json_file:
        return _file_text(json_file)
    return ""


def _validate_json_text(name: str, text: str) -> None:
    if not text:
        return
    try:
        json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{name} must contain valid JSON: {exc}") from exc


def load_env_file(path: Path = DEFAULT_ENV_FILE) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if key and key not in os.environ:
            os.environ[key] = val


@dataclass(frozen=True)
class IntegrationSettings:
    api_base_url: str
    keycloak_token_url: str
    keycloak_password_grant_client_id: str
    keycloak_username: str
    keycloak_password: str
    keycloak_admin_password: str
    verify_tls: bool
    enable_password_grant: bool
    # S3-compatible object store (MinIO, s3gateway, AWS S3, …)
    s3_endpoint: str
    s3_bucket: str
    s3_prefix: str
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str
    integration_cleanup: bool
    skip_acquisition: bool
    skip_analytics: bool
    skip_connection_test: bool
    connection_test_timeout_sec: int
    project_init_timeout_sec: int
    project_init_poll_interval_sec: int
    seed_s3_marker: bool
    e2e_search_query: str
    s3compatible_e2e_search_query: str
    skip_search: bool
    acquisition_timeout_sec: int
    acquisition_poll_interval_sec: int
    kb_timeout_sec: int
    kb_poll_interval_sec: int
    e2e_search_marker_prefix: str
    kb_embedding_model: str
    kb_chunk_size: int
    kb_vector_size: int
    search_top_k: int
    # PostgreSQL connector (optional)
    postgres_host: str
    postgres_port: int
    postgres_database: str
    postgres_schema: str
    postgres_username: str
    postgres_password: str
    postgres_ssl_mode: str
    postgres_sql_query: str
    postgres_source_table: str
    postgres_e2e_search_query: str
    postgres_kb_text_columns: str
    # MySQL connector (optional)
    mysql_host: str
    mysql_port: int
    mysql_database: str
    mysql_schema: str
    mysql_username: str
    mysql_password: str
    mysql_ssl_mode: str
    mysql_sql_query: str
    mysql_source_table: str
    mysql_e2e_search_query: str
    mysql_kb_text_columns: str
    # Azure / ANF (optional)
    azure_subscription_id: str
    azure_default_region: str
    azure_tenant_id: str
    azure_client_id: str
    azure_client_secret: str
    azure_resource_group: str
    anf_test_pool_arm_id: str
    anf_test_volume_arm_id: str
    anf_metric_categories: str
    anf_acquisition_timeout_sec: int
    anf_mcp_provision_timeout_sec: int
    anf_mcp_allow_write: bool
    # GCP GCNV metrics connector (optional)
    gcp_project_id: str
    gcp_service_account_json: str
    gcp_default_region: str
    # ONTAP metrics connector (optional)
    ontap_cluster_url: str
    ontap_verify_tls: bool
    ontap_default_svm: str
    ontap_username: str
    ontap_password: str
    # Redash connector (optional)
    redash_url: str
    redash_api_key: str
    redash_verify_tls: bool
    # Volume datasource (optional)
    volume_region: str
    volume_endpoint: str
    volume_protocol: str
    volume_mount_options: list[str]
    volume_auth_type: str
    volume_auth_username: str
    volume_auth_password: str
    volume_scan_depth: str
    # Manual unstructured upload (optional — defaults to built-in synthetic file)
    manual_upload_file_path: str
    manual_upload_file_name: str
    manual_upload_content_type: str

    @classmethod
    def from_env(cls) -> IntegrationSettings:
        load_env_file()
        insecure = _flag("CURL_INSECURE")
        gcp_sa_json = _resolve_gcp_service_account_json()
        _validate_json_text("GCP service account", gcp_sa_json)
        api_base = _strip(os.environ.get("API_BASE_URL"))
        if not api_base:
            raise ValueError("API_BASE_URL is required in tests/integration/.env.local")
        token_url = _strip(os.environ.get("KEYCLOAK_TOKEN_URL")) or _derive_token_url(api_base)
        if not token_url:
            raise ValueError(
                "KEYCLOAK_TOKEN_URL is unset and cannot be derived from "
                f"API_BASE_URL={api_base!r} (host must start with 'app.'). "
                "Set KEYCLOAK_TOKEN_URL explicitly in tests/integration/.env.local."
            )
        username = _strip(os.environ.get("KEYCLOAK_USERNAME"))
        password = _strip(os.environ.get("KEYCLOAK_PASSWORD"))
        if not username or not password:
            raise ValueError(
                "KEYCLOAK_USERNAME and KEYCLOAK_PASSWORD are required in .env.local"
            )
        return cls(
            api_base_url=api_base.rstrip("/"),
            keycloak_token_url=token_url,
            keycloak_password_grant_client_id=(
                _strip(os.environ.get("KEYCLOAK_PASSWORD_GRANT_CLIENT_ID"))
                or _strip(os.environ.get("KEYCLOAK_CLIENT_ID"))
                or "agent-studio-ui"
            ),
            keycloak_username=username,
            keycloak_password=password,
            keycloak_admin_password=_strip(os.environ.get("KEYCLOAK_ADMIN_PASSWORD"))
            or "AgentstudioAdmin123!",
            verify_tls=not insecure,
            enable_password_grant=_flag("KEYCLOAK_ENABLE_PASSWORD_GRANT"),
            s3_endpoint=_strip(os.environ.get("S3_ENDPOINT")),
            s3_bucket=_strip(os.environ.get("S3_BUCKET")),
            s3_prefix=_strip(os.environ.get("S3_PREFIX")),
            aws_access_key_id=_strip(os.environ.get("AWS_ACCESS_KEY_ID")),
            aws_secret_access_key=_strip(os.environ.get("AWS_SECRET_ACCESS_KEY")),
            aws_region=_strip(os.environ.get("AWS_REGION")) or "us-east-1",
            integration_cleanup=_flag("INTEGRATION_CLEANUP", default=True),
            skip_acquisition=_flag("SKIP_ACQUISITION"),
            skip_analytics=_flag("SKIP_ANALYTICS"),
            skip_connection_test=_flag("SKIP_CONNECTION_TEST"),
            connection_test_timeout_sec=int(
                _strip(os.environ.get("CONNECTION_TEST_TIMEOUT_SEC")) or "90"
            ),
            project_init_timeout_sec=int(
                _strip(os.environ.get("PROJECT_INIT_TIMEOUT_SEC")) or "60"
            ),
            project_init_poll_interval_sec=int(
                _strip(os.environ.get("PROJECT_INIT_POLL_INTERVAL_SEC")) or "5"
            ),
            seed_s3_marker=_flag("INTEGRATION_SEED_S3", default=True),
            e2e_search_query=_strip(os.environ.get("E2E_SEARCH_QUERY")),
            s3compatible_e2e_search_query=_strip(
                os.environ.get("S3COMPATIBLE_E2E_SEARCH_QUERY")
            ),
            skip_search=_flag("SKIP_SEARCH"),
            acquisition_timeout_sec=int(
                _strip(os.environ.get("ACQUISITION_TIMEOUT_SEC")) or "900"
            ),
            acquisition_poll_interval_sec=int(
                _strip(os.environ.get("ACQUISITION_POLL_INTERVAL_SEC")) or "10"
            ),
            kb_timeout_sec=int(_strip(os.environ.get("KB_CREATION_TIMEOUT_SEC")) or "1200"),
            kb_poll_interval_sec=int(
                _strip(os.environ.get("KB_POLL_INTERVAL_SEC")) or "15"
            ),
            e2e_search_marker_prefix=_strip(os.environ.get("E2E_SEARCH_MARKER_PREFIX"))
            or "E2E_MARKER_",
            kb_embedding_model=_strip(os.environ.get("KB_EMBEDDING_MODEL"))
            or "sentence-transformers/all-MiniLM-L6-v2",
            kb_chunk_size=int(_strip(os.environ.get("KB_CHUNK_SIZE")) or "512"),
            kb_vector_size=int(_strip(os.environ.get("KB_VECTOR_SIZE")) or "384"),
            search_top_k=int(_strip(os.environ.get("SEARCH_TOP_K")) or "5"),
            postgres_host=_strip(os.environ.get("POSTGRES_HOST")),
            postgres_port=int(_strip(os.environ.get("POSTGRES_PORT")) or "5432"),
            postgres_database=_strip(os.environ.get("POSTGRES_DATABASE")),
            postgres_schema=_strip(os.environ.get("POSTGRES_SCHEMA")) or "public",
            postgres_username=_strip(os.environ.get("POSTGRES_USERNAME")),
            postgres_password=_strip(os.environ.get("POSTGRES_PASSWORD")),
            postgres_ssl_mode=_strip(os.environ.get("POSTGRES_SSL_MODE")) or "prefer",
            postgres_sql_query=_env_sql(os.environ.get("POSTGRES_SQL_QUERY")),
            postgres_source_table=_strip(os.environ.get("POSTGRES_SOURCE_TABLE")),
            postgres_e2e_search_query=_strip(os.environ.get("POSTGRES_E2E_SEARCH_QUERY")),
            postgres_kb_text_columns=_strip(os.environ.get("POSTGRES_KB_TEXT_COLUMNS")),
            mysql_host=_strip(os.environ.get("MYSQL_HOST")),
            mysql_port=int(_strip(os.environ.get("MYSQL_PORT")) or "3306"),
            mysql_database=_strip(os.environ.get("MYSQL_DATABASE")),
            mysql_schema=_strip(os.environ.get("MYSQL_SCHEMA")) or "",
            mysql_username=_strip(os.environ.get("MYSQL_USERNAME")),
            mysql_password=_strip(os.environ.get("MYSQL_PASSWORD")),
            mysql_ssl_mode=_strip(os.environ.get("MYSQL_SSL_MODE")) or "prefer",
            mysql_sql_query=_env_sql(os.environ.get("MYSQL_SQL_QUERY")),
            mysql_source_table=_strip(os.environ.get("MYSQL_SOURCE_TABLE")),
            mysql_e2e_search_query=_strip(os.environ.get("MYSQL_E2E_SEARCH_QUERY")),
            mysql_kb_text_columns=_strip(os.environ.get("MYSQL_KB_TEXT_COLUMNS")),
            azure_subscription_id=_strip(os.environ.get("AZURE_SUBSCRIPTION_ID")),
            azure_default_region=_strip(os.environ.get("AZURE_DEFAULT_REGION")),
            azure_tenant_id=_strip(os.environ.get("AZURE_TENANT_ID")),
            azure_client_id=_strip(os.environ.get("AZURE_CLIENT_ID")),
            azure_client_secret=_strip(os.environ.get("AZURE_CLIENT_SECRET")),
            azure_resource_group=_strip(os.environ.get("AZURE_RESOURCE_GROUP")),
            anf_test_pool_arm_id=_strip(os.environ.get("ANF_TEST_POOL_ARM_ID")),
            anf_test_volume_arm_id=_strip(os.environ.get("ANF_TEST_VOLUME_ARM_ID")),
            anf_metric_categories=_strip(os.environ.get("ANF_METRIC_CATEGORIES"))
            or "volume_metrics",
            anf_acquisition_timeout_sec=int(
                _strip(os.environ.get("ANF_ACQUISITION_TIMEOUT_SEC")) or "900"
            ),
            anf_mcp_provision_timeout_sec=int(
                _strip(os.environ.get("ANF_MCP_PROVISION_TIMEOUT_SEC")) or "900"
            ),
            anf_mcp_allow_write=_flag("ANF_MCP_ALLOW_WRITE"),
            gcp_project_id=_strip(os.environ.get("GCP_PROJECT_ID")),
            gcp_service_account_json=gcp_sa_json,
            gcp_default_region=_strip(os.environ.get("GCP_DEFAULT_REGION")) or "us-central1",
            ontap_cluster_url=_strip(os.environ.get("ONTAP_CLUSTER_URL")),
            ontap_verify_tls=_flag("ONTAP_VERIFY_TLS", default=True),
            ontap_default_svm=_strip(os.environ.get("ONTAP_DEFAULT_SVM")),
            ontap_username=_strip(os.environ.get("ONTAP_USERNAME")),
            ontap_password=_strip(os.environ.get("ONTAP_PASSWORD")),
            redash_url=_strip(os.environ.get("REDASH_URL")),
            redash_api_key=_strip(os.environ.get("REDASH_API_KEY")),
            redash_verify_tls=_flag("REDASH_VERIFY_TLS", default=True),
            volume_region=_strip(os.environ.get("VOLUME_REGION")) or "us-west-2",
            volume_endpoint=_strip(os.environ.get("VOLUME_ENDPOINT")),
            volume_protocol=_strip(os.environ.get("VOLUME_PROTOCOL")) or "nfs",
            volume_mount_options=[
                o.strip()
                for o in _strip(os.environ.get("VOLUME_MOUNT_OPTIONS")).split(",")
                if o.strip()
            ]
            or ["noac"],
            volume_auth_type=_strip(os.environ.get("VOLUME_AUTH_TYPE")) or "none",
            volume_auth_username=_strip(os.environ.get("VOLUME_AUTH_USERNAME")),
            volume_auth_password=_strip(os.environ.get("VOLUME_AUTH_PASSWORD")),
            volume_scan_depth=_strip(os.environ.get("VOLUME_SCAN_DEPTH")) or "shallow",
            manual_upload_file_path=_strip(os.environ.get("MANUAL_UPLOAD_FILE_PATH")),
            manual_upload_file_name=_strip(os.environ.get("MANUAL_UPLOAD_FILE_NAME")),
            manual_upload_content_type=_strip(
                os.environ.get("MANUAL_UPLOAD_CONTENT_TYPE")
            ),
        )

    def resolved_s3compatible_search_query(self) -> str:
        return self.s3compatible_e2e_search_query or self.e2e_search_query

    def resolved_postgres_search_query(self) -> str:
        return self.postgres_e2e_search_query or self.e2e_search_query

    def resolved_mysql_search_query(self) -> str:
        return self.mysql_e2e_search_query or self.e2e_search_query

    def require_s3compatible(self) -> None:
        missing = [
            name
            for name, val in (
                ("S3_ENDPOINT", self.s3_endpoint),
                ("S3_BUCKET", self.s3_bucket),
                ("AWS_ACCESS_KEY_ID", self.aws_access_key_id),
                ("AWS_SECRET_ACCESS_KEY", self.aws_secret_access_key),
            )
            if not val
        ]
        if missing:
            raise ValueError(
                f"Missing S3-compatible settings in .env.local: {', '.join(missing)}"
            )

    def has_s3compatible(self) -> bool:
        return bool(
            self.s3_endpoint
            and self.s3_bucket
            and self.aws_access_key_id
            and self.aws_secret_access_key
        )

    def has_postgres(self) -> bool:
        return bool(
            self.postgres_host
            and self.postgres_database
            and self.postgres_username
            and self.postgres_password
            and self.postgres_source_table
        )

    def require_postgres(self) -> None:
        missing = [
            name
            for name, val in (
                ("POSTGRES_HOST", self.postgres_host),
                ("POSTGRES_DATABASE", self.postgres_database),
                ("POSTGRES_USERNAME", self.postgres_username),
                ("POSTGRES_PASSWORD", self.postgres_password),
                ("POSTGRES_SOURCE_TABLE", self.postgres_source_table),
            )
            if not val
        ]
        if missing:
            raise ValueError(
                f"Missing PostgreSQL settings in .env.local: {', '.join(missing)}"
            )

    def has_mysql(self) -> bool:
        return bool(
            self.mysql_host
            and self.mysql_database
            and self.mysql_username
            and self.mysql_password
            and self.mysql_source_table
        )

    def require_mysql(self) -> None:
        missing = [
            name
            for name, val in (
                ("MYSQL_HOST", self.mysql_host),
                ("MYSQL_DATABASE", self.mysql_database),
                ("MYSQL_USERNAME", self.mysql_username),
                ("MYSQL_PASSWORD", self.mysql_password),
                ("MYSQL_SOURCE_TABLE", self.mysql_source_table),
            )
            if not val
        ]
        if missing:
            raise ValueError(
                f"Missing MySQL settings in .env.local: {', '.join(missing)}"
            )

    def anf_metric_category_list(self) -> list[str]:
        return [c.strip() for c in self.anf_metric_categories.split(",") if c.strip()]

    def has_azure_cloud(self) -> bool:
        return bool(
            self.azure_subscription_id
            and self.azure_default_region
            and self.azure_tenant_id
            and self.azure_client_id
            and self.azure_client_secret
        )

    def require_azure_cloud(self) -> None:
        missing = [
            name
            for name, val in (
                ("AZURE_SUBSCRIPTION_ID", self.azure_subscription_id),
                ("AZURE_DEFAULT_REGION", self.azure_default_region),
                ("AZURE_TENANT_ID", self.azure_tenant_id),
                ("AZURE_CLIENT_ID", self.azure_client_id),
                ("AZURE_CLIENT_SECRET", self.azure_client_secret),
            )
            if not val
        ]
        if missing:
            raise ValueError(
                f"Missing Azure cloud settings in .env.local: {', '.join(missing)}"
            )

    def has_anf_mcp_fixtures(self) -> bool:
        return self.has_azure_cloud() and bool(
            self.anf_test_pool_arm_id and self.anf_test_volume_arm_id
        )

    def has_gcp_metrics(self) -> bool:
        return bool(self.gcp_project_id and self.gcp_service_account_json)

    def require_gcp_metrics(self) -> None:
        missing = [
            name
            for name, val in (
                ("GCP_PROJECT_ID", self.gcp_project_id),
                ("GCP_SERVICE_ACCOUNT_JSON_FILE", self.gcp_service_account_json),
            )
            if not val
        ]
        if missing:
            raise ValueError(
                f"Missing GCP metrics settings in .env.local: {', '.join(missing)}"
            )

    def has_ontap_metrics(self) -> bool:
        return bool(
            self.ontap_cluster_url
            and self.ontap_username
            and self.ontap_password
        )

    def require_ontap_metrics(self) -> None:
        missing = [
            name
            for name, val in (
                ("ONTAP_CLUSTER_URL", self.ontap_cluster_url),
                ("ONTAP_USERNAME", self.ontap_username),
                ("ONTAP_PASSWORD", self.ontap_password),
            )
            if not val
        ]
        if missing:
            raise ValueError(
                f"Missing ONTAP metrics settings in .env.local: {', '.join(missing)}"
            )

    def has_redash(self) -> bool:
        return bool(self.redash_url and self.redash_api_key)

    def has_volume(self) -> bool:
        return bool(self.volume_endpoint)

    def volume_auth_info(self) -> dict[str, str]:
        auth: dict[str, str] = {"type": self.volume_auth_type}
        if self.volume_auth_type == "basic":
            auth["username"] = self.volume_auth_username
            auth["password"] = self.volume_auth_password
        return auth

    def volume_scan_config(self) -> dict[str, str] | None:
        if not self.volume_scan_depth or self.volume_scan_depth == "none":
            return None
        return {"scan_depth": self.volume_scan_depth}
