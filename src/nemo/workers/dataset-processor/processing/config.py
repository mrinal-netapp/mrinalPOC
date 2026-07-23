"""Configuration dataclass for dataset processing.

Absorbs the 23 module-level globals from the legacy processor.py into a single
Config object that can be constructed from environment variables or from a dict
(the primary path when called as a Temporal activity).
"""

import os
from observability_client_runtime import get_logger
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = get_logger()


@dataclass
class Config:
    """Dataset processing configuration."""

    # Core identifiers
    dataset_id: str = ""
    dataset_name: str = ""
    dataset_kind: str = "structured"
    dataset_type: str = ""  # "manual" | "acquired" — set by workflow input
    project_id: str = ""
    bucket_name: str = ""
    namespace: str = "default"

    # External service URLs
    lakekeeper_url: str = "http://lakekeeper:8181"
    keycloak_internal_issuer: str = ""
    config_service_url: str = "http://config-service:3000"

    # Authentication
    project_client_id: str = ""
    project_client_secret: str = ""
    warehouse_id: str = ""

    # S3 configuration
    s3_endpoint: str = ""
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_region: str = "us-east-1"
    s3_path_prefix: str = ""

    # PII feature flags
    enable_pii_analysis: bool = False
    pii_analysis_image_only: bool = False
    reprocess_pii_only: bool = False
    workflow_id: str = ""

    # Work-unit / partition fields (populated from Go FileSet / WorkPlan)
    manifest_s3_key: str = ""
    output_prefix: str = ""
    set_id: str = ""
    job_output_prefix: str = ""

    # MIME type constants (not configurable, but part of processing context)
    text_mime_prefixes: tuple = field(
        default=("text/", "application/json", "application/xml", "application/csv"),
        repr=False,
    )
    text_extensions: frozenset = field(
        default_factory=lambda: frozenset(
            {".txt", ".csv", ".json", ".xml", ".html", ".md", ".yaml", ".yml", ".log", ".tsv"}
        ),
        repr=False,
    )
    image_mime_prefix: str = field(default="image/", repr=False)
    image_extensions: frozenset = field(
        default_factory=lambda: frozenset(
            {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".tif", ".webp"}
        ),
        repr=False,
    )
    document_mime_types: frozenset = field(
        default_factory=lambda: frozenset({
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
        repr=False,
    )
    document_extensions: frozenset = field(
        default_factory=lambda: frozenset({".pdf", ".docx", ".pptx"}),
        repr=False,
    )

    @classmethod
    def from_environment(cls) -> "Config":
        """Construct Config from environment variables (backward-compat / standalone testing)."""
        def _bool(val: str) -> bool:
            return val.lower() in ("true", "1", "yes")

        return cls(
            dataset_id=os.environ.get("DATASET_ID", ""),
            dataset_name=os.environ.get("DATASET_NAME", ""),
            dataset_kind=os.environ.get("DATASET_KIND", "structured"),
            dataset_type=os.environ.get("DATASET_TYPE", ""),
            project_id=os.environ.get("PROJECT_ID", ""),
            bucket_name=os.environ.get("BUCKET_NAME", ""),
            namespace=os.environ.get("NAMESPACE", "default"),
            lakekeeper_url=os.environ.get("LAKEKEEPER_URL", "http://lakekeeper:8181"),
            keycloak_internal_issuer=os.environ.get("KEYCLOAK_INTERNAL_ISSUER", ""),
            config_service_url=os.environ.get("CONFIG_SERVICE_URL", "http://config-service:3000"),
            project_client_id=os.environ.get("PROJECT_CLIENT_ID", ""),
            project_client_secret=os.environ.get("PROJECT_CLIENT_SECRET", ""),
            warehouse_id=os.environ.get("WAREHOUSE_ID", ""),
            s3_endpoint=os.environ.get("S3_ENDPOINT", ""),
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", ""),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", ""),
            aws_region=os.environ.get("AWS_REGION", "us-east-1"),
            s3_path_prefix=os.environ.get("S3_PATH_PREFIX", ""),
            enable_pii_analysis=_bool(os.environ.get("ENABLE_PII_ANALYSIS", "false")),
            pii_analysis_image_only=_bool(os.environ.get("PII_ANALYSIS_IMAGE_ONLY", "false")),
            reprocess_pii_only=_bool(os.environ.get("REPROCESS_PII_ONLY", "false")),
            workflow_id=os.environ.get("WORKFLOW_ID", ""),
            manifest_s3_key=os.environ.get("PARTITION_MANIFEST_KEY", ""),
            output_prefix=os.environ.get("PARTITION_OUTPUT_PREFIX", ""),
            set_id=os.environ.get("PARTITION_ID", ""),
            job_output_prefix=os.environ.get("JOB_OUTPUT_PREFIX", ""),
        )

    @classmethod
    def from_dict(cls, data: dict) -> "Config":
        """Construct Config from a dict (primary path for Temporal activity input).

        The dict uses snake_case field names matching Python conventions. The Go
        workflow maps its ProjectCredentials fields to these names before dispatch.
        """
        def _bool(val) -> bool:
            if isinstance(val, bool):
                return val
            if isinstance(val, str):
                return val.lower() in ("true", "1", "yes")
            return bool(val)

        known_fields = {f.name for f in cls.__dataclass_fields__.values()
                        if f.name not in ("text_mime_prefixes", "text_extensions",
                                          "image_mime_prefix", "image_extensions",
                                          "document_mime_types", "document_extensions")}
        kwargs = {}
        for key, value in data.items():
            if key in known_fields:
                target_type = cls.__dataclass_fields__[key].type
                if target_type is bool:
                    kwargs[key] = _bool(value)
                else:
                    kwargs[key] = value
        return cls(**kwargs)

    def effective_warehouse_id(self) -> str:
        """Lakekeeper warehouse name: workflow input, then WAREHOUSE_NAME / DEPLOYMENT_NAME env."""
        w = (self.warehouse_id or "").strip()
        if w:
            return w
        for key in ("WAREHOUSE_NAME", "DEPLOYMENT_NAME"):
            v = os.environ.get(key, "").strip()
            if v:
                return v
        raise ValueError(
            "warehouse_id is required for catalog operations (or set WAREHOUSE_NAME / DEPLOYMENT_NAME)"
        )

    def validate(self) -> None:
        """Validate required fields. Raises ValueError on missing config."""
        required = {
            "dataset_id": self.dataset_id,
            "dataset_name": self.dataset_name,
            "project_id": self.project_id,
            "bucket_name": self.bucket_name,
            "project_client_id": self.project_client_id,
            "project_client_secret": self.project_client_secret,
            "aws_access_key_id": self.aws_access_key_id,
            "aws_secret_access_key": self.aws_secret_access_key,
            "s3_endpoint": self.s3_endpoint,
        }
        missing = [name for name, val in required.items() if not val]
        if missing:
            raise ValueError(f"Missing required config fields: {', '.join(missing)}")

    def get_access_token(self) -> str:
        """Get OAuth2 access token using project service account credentials."""
        import requests

        issuer = (self.keycloak_internal_issuer or "").strip()
        if not issuer:
            raise ValueError("keycloak_internal_issuer is required for OAuth2 token exchange")

        token_url = f"{issuer}/protocol/openid-connect/token"
        params = {
            "grant_type": "client_credentials",
            "client_id": self.project_client_id,
            "client_secret": self.project_client_secret,
            "scope": "openid profile email",
        }
        response = requests.post(
            token_url,
            data=params,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        response.raise_for_status()
        return response.json()["access_token"]

    def get_authenticated_session(self):
        """Create authenticated requests session with OAuth2 token."""
        import requests

        session = requests.Session()
        token = self.get_access_token()
        session.headers.update({
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })
        return session

    @staticmethod
    def default_store_root() -> Optional[str]:
        """Return the default app-scoped PVC mount root, else None."""
        p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
        return p or None

    def posix_path(self, key: str) -> Path:
        """Resolve a storage key to a local filesystem path under the default PVC mount.

        Uses NEMO_DEFAULT_STORE_ROOT (default ``/mnt/pvcs/default-nemo``).
        The mount mirrors the VersityGW POSIX backend layout so
        ``s3://{bucket}/{key}`` lives at ``{mount}/{key}``.
        """
        root = self.default_store_root() or "/mnt/pvcs/default-nemo"
        return Path(root) / key

    def use_posix(self) -> bool:
        """True when POSIX I/O should replace S3 API calls."""
        return self.default_store_root() is not None

    def progress_key(self, override: Optional[str] = None) -> str:
        """Return the S3 key for progress.json."""
        if override:
            return override
        if self.s3_path_prefix:
            return f"{self.s3_path_prefix}/datasets/{self.dataset_id}/progress.json"
        return f"datasets/{self.dataset_id}/progress.json"

    def result_key(self) -> str:
        """Return the S3 key for processing_result.json."""
        if self.s3_path_prefix:
            return f"{self.s3_path_prefix}/datasets/{self.dataset_id}/processing_result.json"
        return f"datasets/{self.dataset_id}/processing_result.json"
