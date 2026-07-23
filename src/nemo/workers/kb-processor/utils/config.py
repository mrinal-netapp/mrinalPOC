"""Configuration management for KB processor."""

import os
import json
from observability_client_runtime import get_logger
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any

logger = get_logger()

# Valid chunking strategies
VALID_CHUNK_STRATEGIES = ['fixed', 'sentence', 'recursive', 'token', 'markdown']

# Valid indexing modes
VALID_INDEXING_MODES = ['hybrid', 'semantic', 'fts']

# Valid quantization types
VALID_QUANTIZATION_TYPES = ['auto', 'none', 'ivf_pq', 'scalar', 'ivf_rq']


@dataclass
class Config:
    """Configuration for KB processor."""

    # Core identifiers
    kb_id: str
    kb_name: str
    project_id: str
    source_dataset_id: str
    bucket_name: str
    namespace: str

    # Processing configuration
    embedding_model: str
    chunk_size: int
    chunk_overlap: int
    chunk_strategy: str  # 'fixed', 'sentence', 'recursive', 'token', 'markdown'
    chunk_options: Dict[str, Any]  # Strategy-specific options
    vector_size: int
    data_type: str
    processing_mode: str  # 'full' or 'incremental'
    indexing_mode: str  # 'hybrid', 'semantic', 'fts' - controls FTS index creation
    quantization_type: str  # 'auto', 'none', 'ivf_pq', 'scalar', 'ivf_rq' - vector index strategy
    quantization_options: Dict[str, Any]  # Options for IVF_PQ quantization (numPartitions, numSubVectors)
    embedding_batch_size: int  # Batch size for embedding generation (default 64)

    # External services
    config_service_url: str
    keycloak_internal_issuer: str

    # Authentication
    project_client_id: str
    project_client_secret: str

    # S3 configuration
    s3_endpoint: str
    aws_access_key_id: str
    aws_secret_access_key: str
    aws_region: str

    # S3 path prefix (e.g., "projects/<projectId>")
    s3_path_prefix: str

    # Structured dataset support
    dataset_kind: str  # 'structured' or 'unstructured'
    catalog_table_ref: Optional[str]  # e.g., "namespace.table_name"
    lakekeeper_url: str
    warehouse_id: Optional[str]
    text_columns: Optional[List[str]]  # User-specified columns for text extraction

    # Gateway-routed embedding (replaces in-process SentenceTransformer).
    # Populated by config-service.knowledgeBaseRoutes when dispatching the
    # KB-creation workflow; the workflow forwards them into the kb-processor
    # activity input. Falls back to env (LLM_GATEWAY_URL etc.) for local
    # pytest runs without a workflow context.
    #
    # Placed at the end of the field list because @dataclass requires all
    # fields with defaults to follow fields without defaults — every field
    # above is non-default.
    llm_gateway_url: str = ''
    project_virtual_key_token: str = ''
    embedding_model_id: str = ''
    embedding_provider: str = ''
    embedding_provider_model_id: str = ''
    # Bifrost wire identifier (`<provider>/<gatewayBindingName>`). Sent as the
    # `model` field on /v1/embeddings. Populated by config-service at workflow-
    # dispatch from Model.gatewayModelId. Falls back to embedding_provider_model_id
    # for the bare-Ollama / non-Bifrost path.
    embedding_gateway_model_id: str = ''
    embedding_endpoint: str = ''  # optional; for remote (non-built-in) models
    embedding_dimensions: int = 384

    @classmethod
    def _parse_embedding_batch_size(cls, value_str: str) -> int:
        """Parse embedding batch size from string, defaulting to 64 on invalid input."""
        try:
            batch_size = int(value_str)
            if batch_size <= 0:
                logger.warning(f"EMBEDDING_BATCH_SIZE must be positive (got {batch_size}). Using default 64.")
                return 64
            return batch_size
        except (ValueError, TypeError):
            logger.warning(f"Invalid EMBEDDING_BATCH_SIZE '{value_str}'. Using default 64.")
            return 64

    @classmethod
    def _parse_quantization_options(cls, options_str: str) -> Dict[str, Any]:
        """Parse quantization options from JSON string."""
        if not options_str:
            return {}
        try:
            options = json.loads(options_str)
            return options
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse QUANTIZATION_OPTIONS JSON: {e}. Using empty options.")
            return {}

    @classmethod
    def from_dict(cls, data: dict) -> 'Config':
        """Construct Config from a dict (primary path for Temporal activity input).

        The dict uses snake_case field names matching Python conventions. The Go
        workflow maps its ProjectCredentials fields to these names before dispatch.
        Also accepts legacy keys (s3_access_key, s3_secret_key, s3_region, keycloak_issuer)
        for backward compatibility.
        """
        def _get(key, default=''):
            # Empty / None values in the workflow input must fall through to
            # the default, not override it. Stuck workflows that were dispatched
            # before the unified-embedding fields were populated by
            # config-service.knowledgeBaseRoutes carry `llm_gateway_url=""`
            # (and similar empty strings) in their permanently-serialized
            # activity input; without this fallthrough every retry would keep
            # using the empty string and bypass the env fallback.
            v = data.get(key, default)
            if v is None or v == '':
                return default
            return v

        def _get_cred(key: str, legacy_key: str, default: str = '') -> str:
            v = _get(key, default)
            if not v and legacy_key:
                v = _get(legacy_key, default)
            return v

        text_columns_str = _get('text_columns', '')
        text_columns = None
        if isinstance(text_columns_str, list):
            text_columns = text_columns_str
        elif text_columns_str:
            text_columns = [c.strip() for c in text_columns_str.split(',') if c.strip()]

        chunk_options = _get('chunk_options', {})
        if isinstance(chunk_options, str):
            try:
                chunk_options = json.loads(chunk_options)
            except (json.JSONDecodeError, TypeError):
                chunk_options = {}

        quantization_options = _get('quantization_options', {})
        if isinstance(quantization_options, str):
            quantization_options = cls._parse_quantization_options(quantization_options)

        config = cls(
            kb_id=_get('kb_id'),
            kb_name=_get('kb_name'),
            project_id=_get('project_id'),
            source_dataset_id=_get('source_dataset_id'),
            bucket_name=_get('bucket_name'),
            namespace=_get('namespace'),
            embedding_model=_get('embedding_model', 'sentence-transformers/all-MiniLM-L6-v2'),
            chunk_size=int(_get('chunk_size', 512)),
            chunk_overlap=int(_get('chunk_overlap', 50)),
            chunk_strategy=_get('chunk_strategy', 'fixed'),
            chunk_options=chunk_options,
            vector_size=int(_get('vector_size', 384)),
            data_type=_get('data_type', 'float32'),
            processing_mode=_get('processing_mode', 'full'),
            indexing_mode=_get('indexing_mode', 'hybrid'),
            quantization_type=_get('quantization_type', 'auto') or 'auto',
            quantization_options=quantization_options,
            embedding_batch_size=cls._parse_embedding_batch_size(str(_get('embedding_batch_size', 64))),
            # Gateway-routed embedding: workflow input populates these from
            # config-service. For each field, fall back to env so local
            # pytest runs (which don't go through the workflow) still work.
            llm_gateway_url=_get('llm_gateway_url', os.environ.get('LLM_GATEWAY_URL', '')),
            project_virtual_key_token=_get(
                'project_virtual_key_token', os.environ.get('PROJECT_VIRTUAL_KEY_TOKEN', '')
            ),
            embedding_model_id=_get('embedding_model_id', os.environ.get('EMBEDDING_MODEL_ID', '')),
            embedding_provider=_get('embedding_provider', os.environ.get('EMBEDDING_PROVIDER', '')),
            embedding_provider_model_id=_get(
                'embedding_provider_model_id',
                os.environ.get('EMBEDDING_PROVIDER_MODEL_ID', ''),
            ),
            embedding_gateway_model_id=_get(
                'embedding_gateway_model_id',
                os.environ.get('EMBEDDING_GATEWAY_MODEL_ID', ''),
            ),
            embedding_endpoint=_get('embedding_endpoint', os.environ.get('EMBEDDING_ENDPOINT', '')),
            embedding_dimensions=int(
                _get('embedding_dimensions', os.environ.get('EMBEDDING_DIMENSIONS', 384)) or 384
            ),
            config_service_url=_get('config_service_url', 'http://config-service:3000'),
            keycloak_internal_issuer=_get_cred('keycloak_internal_issuer', 'keycloak_issuer', 'http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo'),
            project_client_id=_get('project_client_id'),
            project_client_secret=_get('project_client_secret'),
            s3_endpoint=_get('s3_endpoint'),
            aws_access_key_id=_get_cred('aws_access_key_id', 's3_access_key'),
            aws_secret_access_key=_get_cred('aws_secret_access_key', 's3_secret_key'),
            aws_region=_get_cred('aws_region', 's3_region', 'us-east-1'),
            s3_path_prefix=_get('s3_path_prefix'),
            dataset_kind=_get('dataset_kind', 'unstructured'),
            catalog_table_ref=_get('catalog_table_ref') or None,
            lakekeeper_url=_get('lakekeeper_url', 'http://lakekeeper:8181'),
            warehouse_id=_get('warehouse_id') or None,
            text_columns=text_columns,
        )
        config.validate()
        return config

    @classmethod
    def from_environment(cls) -> 'Config':
        """Create Config from environment variables."""
        # Parse text columns if specified
        text_columns_str = os.environ.get('TEXT_COLUMNS', '')
        text_columns = None
        if text_columns_str:
            text_columns = [c.strip() for c in text_columns_str.split(',') if c.strip()]

        # Parse chunk options JSON
        chunk_options_str = os.environ.get('CHUNK_OPTIONS', '')
        chunk_options = {}
        if chunk_options_str:
            try:
                chunk_options = json.loads(chunk_options_str)
            except json.JSONDecodeError as e:
                logger.warning(f"Failed to parse CHUNK_OPTIONS JSON: {e}. Using empty options.")
                chunk_options = {}

        config = cls(
            # Core identifiers
            kb_id=os.environ.get('KB_ID', ''),
            kb_name=os.environ.get('KB_NAME', ''),
            project_id=os.environ.get('PROJECT_ID', ''),
            source_dataset_id=os.environ.get('SOURCE_DATASET_ID', ''),
            bucket_name=os.environ.get('BUCKET_NAME', ''),
            namespace=os.environ.get('NAMESPACE', ''),

            # Processing configuration
            embedding_model=os.environ.get('EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2'),
            chunk_size=int(os.environ.get('CHUNK_SIZE', '512')),
            chunk_overlap=int(os.environ.get('CHUNK_OVERLAP', '50')),
            chunk_strategy=os.environ.get('CHUNK_STRATEGY', 'fixed'),
            chunk_options=chunk_options,
            vector_size=int(os.environ.get('VECTOR_SIZE', '384')),
            data_type=os.environ.get('DATA_TYPE', 'float32'),
            processing_mode=os.environ.get('PROCESSING_MODE', 'full'),  # 'full' or 'incremental'
            indexing_mode=os.environ.get('INDEXING_MODE', 'hybrid'),  # 'hybrid', 'semantic', 'fts'
            quantization_type=os.environ.get('QUANTIZATION_TYPE', '') or 'auto',  # 'auto', 'none', 'ivf_pq', 'scalar', 'ivf_rq'
            quantization_options=cls._parse_quantization_options(os.environ.get('QUANTIZATION_OPTIONS', '')),
            embedding_batch_size=cls._parse_embedding_batch_size(os.environ.get('EMBEDDING_BATCH_SIZE', '64')),

            # Gateway-routed embedding (env-only path; production goes through from_dict)
            llm_gateway_url=os.environ.get('LLM_GATEWAY_URL', ''),
            project_virtual_key_token=os.environ.get('PROJECT_VIRTUAL_KEY_TOKEN', ''),
            embedding_model_id=os.environ.get('EMBEDDING_MODEL_ID', ''),
            embedding_provider=os.environ.get('EMBEDDING_PROVIDER', ''),
            embedding_provider_model_id=os.environ.get('EMBEDDING_PROVIDER_MODEL_ID', ''),
            embedding_gateway_model_id=os.environ.get('EMBEDDING_GATEWAY_MODEL_ID', ''),
            embedding_endpoint=os.environ.get('EMBEDDING_ENDPOINT', ''),
            embedding_dimensions=int(os.environ.get('EMBEDDING_DIMENSIONS', '384') or '384'),

            # External services
            config_service_url=os.environ.get('CONFIG_SERVICE_URL', 'http://config-service:3000'),
            keycloak_internal_issuer=os.environ.get('KEYCLOAK_INTERNAL_ISSUER', 'http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo'),

            # Authentication
            project_client_id=os.environ.get('PROJECT_CLIENT_ID', ''),
            project_client_secret=os.environ.get('PROJECT_CLIENT_SECRET', ''),

            # S3 configuration
            s3_endpoint=os.environ.get('S3_ENDPOINT', ''),
            aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID', ''),
            aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY', ''),
            aws_region=os.environ.get('AWS_REGION', 'us-east-1'),

            # S3 path prefix
            s3_path_prefix=os.environ.get('S3_PATH_PREFIX', ''),

            # Structured dataset support
            dataset_kind=os.environ.get('DATASET_KIND', 'unstructured'),
            catalog_table_ref=os.environ.get('CATALOG_TABLE_REF'),
            lakekeeper_url=os.environ.get('LAKEKEEPER_URL', 'http://lakekeeper:8181'),
            warehouse_id=os.environ.get('WAREHOUSE_ID'),
            text_columns=text_columns,
        )

        config.validate()
        return config

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
            "warehouse_id is required for structured catalog access "
            "(or set WAREHOUSE_NAME / DEPLOYMENT_NAME)"
        )

    def validate(self) -> None:
        """Validate required configuration."""
        required_vars = [
            ('kb_id', 'KB_ID'),
            ('kb_name', 'KB_NAME'),
            ('project_id', 'PROJECT_ID'),
            ('source_dataset_id', 'SOURCE_DATASET_ID'),
            ('bucket_name', 'BUCKET_NAME'),
            ('project_client_id', 'PROJECT_CLIENT_ID'),
            ('project_client_secret', 'PROJECT_CLIENT_SECRET'),
        ]

        missing = [env_name for attr_name, env_name in required_vars if not getattr(self, attr_name)]

        if missing:
            raise ValueError(f"Missing required config fields: {', '.join(missing)}")

        # Validate structured dataset requirements
        if self.dataset_kind == 'structured':
            if not self.catalog_table_ref:
                raise ValueError("CATALOG_TABLE_REF is required for structured datasets")
            if not self.text_columns:
                raise ValueError("TEXT_COLUMNS is required for structured datasets (comma-separated list of column names)")

        # Validate processing mode
        if self.processing_mode not in ('full', 'incremental'):
            raise ValueError(f"Invalid PROCESSING_MODE '{self.processing_mode}'. Must be 'full' or 'incremental'")

        # Validate chunking strategy
        if self.chunk_strategy not in VALID_CHUNK_STRATEGIES:
            raise ValueError(f"Invalid CHUNK_STRATEGY '{self.chunk_strategy}'. Must be one of: {', '.join(VALID_CHUNK_STRATEGIES)}")

        # Validate indexing mode
        if self.indexing_mode not in VALID_INDEXING_MODES:
            raise ValueError(f"Invalid INDEXING_MODE '{self.indexing_mode}'. Must be one of: {', '.join(VALID_INDEXING_MODES)}")

        # Validate quantization type
        if self.quantization_type not in VALID_QUANTIZATION_TYPES:
            raise ValueError(f"Invalid QUANTIZATION_TYPE '{self.quantization_type}'. Must be one of: {', '.join(VALID_QUANTIZATION_TYPES)}")

        # Validate embedding batch size
        if self.embedding_batch_size <= 0:
            logger.warning(f"EMBEDDING_BATCH_SIZE must be positive (got {self.embedding_batch_size}). Using default 64.")
            self.embedding_batch_size = 64
        elif self.embedding_batch_size > 4096:
            logger.warning(f"EMBEDDING_BATCH_SIZE is very large ({self.embedding_batch_size}). This may cause OOM for large models.")

        logger.info(f"Configuration validated for KB: {self.kb_id}")
        logger.info(f"Dataset kind: {self.dataset_kind}, Processing mode: {self.processing_mode}")
        logger.info(f"Embedding model: {self.embedding_model}, batch_size: {self.embedding_batch_size}")
        logger.info(f"Chunking: strategy={self.chunk_strategy}, size={self.chunk_size}, overlap={self.chunk_overlap}")
        logger.info(f"Indexing mode: {self.indexing_mode}")
        logger.info(f"Quantization: type={self.quantization_type}, options={self.quantization_options}")
        if self.chunk_options:
            logger.info(f"Chunk options: {self.chunk_options}")

        if self.dataset_kind == 'structured':
            logger.info(f"Catalog table ref: {self.catalog_table_ref}")
            logger.info(f"Text columns: {self.text_columns}")
