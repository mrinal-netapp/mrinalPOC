import os


class Settings:
    DEBUG: bool = os.getenv("DEBUG", "false").lower() in ("1", "true", "yes")
    CONFIG_SERVICE_URL: str = os.getenv("CONFIG_SERVICE_URL", "http://config-service:3000")
    LLM_GATEWAY_URL: str = os.getenv("LLM_GATEWAY_URL", "http://bifrost-proxy:8080")
    LLM_GATEWAY_API_KEY: str = os.getenv("LLM_GATEWAY_API_KEY", "")
    KB_RETRIEVAL_URL: str = os.getenv("KB_RETRIEVAL_SERVICE_URL", "http://kb-retrieval-service:5000")
    ANALYTICS_ENGINE_URL: str = os.getenv("ANALYTICS_ENGINE_URL", "http://analytics-engine:8080")

    REDIS_URL: str = os.getenv("REDIS_URL", "redis://redis:6379/0")
    REDIS_SENTINEL_URL: str = os.getenv("REDIS_SENTINEL_URL", "")
    REDIS_SENTINEL_MASTER: str = os.getenv("REDIS_SENTINEL_MASTER", "mymaster")
    REDIS_DB: int = int(os.getenv("REDIS_DB", "0"))
    REDIS_PASSWORD: str = os.getenv("REDIS_PASSWORD", "")
    POSTGRES_URL: str = os.getenv(
        "POSTGRES_URL",
        "postgresql://postgres:postgrespassword@postgres:5432/nemo",
    )
    DB_POOL_SIZE: int = int(os.getenv("DB_POOL_SIZE", "3"))
    DB_MAX_OVERFLOW: int = int(os.getenv("DB_MAX_OVERFLOW", "2"))

    KEYCLOAK_INTERNAL_ISSUER: str = os.getenv("KEYCLOAK_INTERNAL_ISSUER", "")
    KEYCLOAK_CLIENT_ID: str = os.getenv("KEYCLOAK_CLIENT_ID", "")
    KEYCLOAK_CLIENT_SECRET: str = os.getenv("KEYCLOAK_CLIENT_SECRET", "")

    CONFIG_CACHE_TTL: int = int(os.getenv("CONFIG_CACHE_TTL", "60"))
    CONFIG_CACHE_MAX_SIZE: int = int(os.getenv("CONFIG_CACHE_MAX_SIZE", "1000"))
    TASK_RESULT_TTL: int = int(os.getenv("TASK_RESULT_TTL", "3600"))
    SESSION_TTL: int = int(os.getenv("SESSION_TTL", "86400"))

    SESSION_MAX_MESSAGES: int = int(os.getenv("SESSION_MAX_MESSAGES", "200"))
    RUNNING_TASK_TTL: int = int(os.getenv("RUNNING_TASK_TTL", "600"))
    MAX_CONCURRENT_INVOCATIONS: int = int(os.getenv("MAX_CONCURRENT_INVOCATIONS", "20"))
    # Context management. See docs/design/agent-service-context-management.md
    CONTEXT_MANAGER_SUMMARIZATION_ENABLED: bool = os.getenv(
        "CONTEXT_MANAGER_SUMMARIZATION_ENABLED", "false",
    ).lower() in ("1", "true", "yes")
    DEFAULT_CONTEXT_STRATEGY: str = os.getenv("DEFAULT_CONTEXT_STRATEGY", "hybrid")
    DEFAULT_VERBATIM_TURNS: int = int(os.getenv("DEFAULT_VERBATIM_TURNS", "3"))
    DEFAULT_TOOL_ROUND_RESERVATION: int = int(os.getenv("DEFAULT_TOOL_ROUND_RESERVATION", "6000"))
    DEFAULT_OUTPUT_RESERVATION_CAP: int = int(os.getenv("DEFAULT_OUTPUT_RESERVATION_CAP", "8192"))
    DEFAULT_OUTPUT_RESERVATION_CAP_EXTENDED: int = int(
        os.getenv("DEFAULT_OUTPUT_RESERVATION_CAP_EXTENDED", "65536"),
    )
    DEFAULT_OUTCOME_SCHEMA_OUTPUT_MULTIPLIER: float = float(
        os.getenv("DEFAULT_OUTCOME_SCHEMA_OUTPUT_MULTIPLIER", "1.4"),
    )
    DEFAULT_SUMMARY_REFRESH_EVERY_TURNS: int = int(
        os.getenv("DEFAULT_SUMMARY_REFRESH_EVERY_TURNS", "5"),
    )
    DEFAULT_SUMMARY_MODEL: str = os.getenv("DEFAULT_SUMMARY_MODEL", "")
    DEFAULT_SUMMARY_MAX_TOKENS: int = int(os.getenv("DEFAULT_SUMMARY_MAX_TOKENS", "300"))
    DEFAULT_SUMMARY_OVERFLOW_THRESHOLD: float = float(
        os.getenv("DEFAULT_SUMMARY_OVERFLOW_THRESHOLD", "0.30"),
    )
    CONTEXT_MANAGER_USE_REAL_TOKENIZERS: bool = os.getenv(
        "CONTEXT_MANAGER_USE_REAL_TOKENIZERS", "false",
    ).lower() in ("1", "true", "yes")
    DEFAULT_SAFETY_BUFFER_CAP: int = int(os.getenv("DEFAULT_SAFETY_BUFFER_CAP", "4096"))
    DEFAULT_SAFETY_BUFFER_PCT: float = float(os.getenv("DEFAULT_SAFETY_BUFFER_PCT", "0.05"))
    DEFAULT_CONTEXT_WINDOW: int = int(os.getenv("DEFAULT_CONTEXT_WINDOW", "8000"))
    MAX_USER_MESSAGE_BYTES: int = int(os.getenv("MAX_USER_MESSAGE_BYTES", "262144"))
    TOKEN_CACHE_MAX_ENTRIES: int = int(os.getenv("TOKEN_CACHE_MAX_ENTRIES", "100000"))

    STATUS_REPORT_INTERVAL: int = int(os.getenv("STATUS_REPORT_INTERVAL", "120"))

    # Log each HTTP request (method, path, status, duration) except /health /ready /metrics
    ACTIVITY_HTTP_LOG: bool = os.getenv("ACTIVITY_HTTP_LOG", "true").lower() in (
        "1",
        "true",
        "yes",
    )
    MCP_IDLE_TTL: int = int(os.getenv("MCP_IDLE_TTL", "600"))

    MCP_INIT_TIMEOUT: int = int(os.getenv("MCP_INIT_TIMEOUT", "30"))
    MCP_HEALTH_CHECK_TIMEOUT: int = int(os.getenv("MCP_HEALTH_CHECK_TIMEOUT", "10"))
    MCP_TOOL_TIMEOUT: int = int(os.getenv("MCP_TOOL_TIMEOUT", "300"))

    MODEL_INFO_CACHE_TTL: int = int(os.getenv("MODEL_INFO_CACHE_TTL", "120"))
    MODEL_INFO_CACHE_MAX: int = int(os.getenv("MODEL_INFO_CACHE_MAX", "200"))
    KB_METADATA_CACHE_TTL: int = int(os.getenv("KB_METADATA_CACHE_TTL", "120"))
    KB_METADATA_CACHE_MAX: int = int(os.getenv("KB_METADATA_CACHE_MAX", "200"))
    KB_SEARCH_TIMEOUT_SECONDS: float = float(os.getenv("KB_SEARCH_TIMEOUT_SECONDS", "30"))
    KB_SEARCH_CONNECT_TIMEOUT_SECONDS: float = float(
        os.getenv("KB_SEARCH_CONNECT_TIMEOUT_SECONDS", "5")
    )
    KB_SEARCH_RETRIES: int = int(os.getenv("KB_SEARCH_RETRIES", "1"))

    # Phoenix query API (REST spans/traces). If empty, derived from PHOENIX_COLLECTOR_ENDPOINT in tracing.get_phoenix_api_url().
    PHOENIX_API_URL: str = os.getenv("PHOENIX_API_URL", "")
    PHOENIX_API_KEY: str = os.getenv("PHOENIX_API_KEY", "")
    # Fallback OpenInference PROJECT_NAME for spans outside an AgentStudio invoke (rare).
    # Per-request invokes use the AgentStudio project id from the URL via tracing.phoenix_project_scope.
    PHOENIX_PROJECT_NAME: str = os.getenv("PHOENIX_PROJECT_NAME", "default")
    PHOENIX_PROXY_TIMEOUT: float = float(os.getenv("PHOENIX_PROXY_TIMEOUT", "15"))


settings = Settings()
