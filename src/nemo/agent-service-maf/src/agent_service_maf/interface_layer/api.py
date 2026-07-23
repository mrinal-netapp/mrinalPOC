"""FastAPI application setup and lifespan management.

Creates the unified agent framework HTTP service with:
- REST / SSE / WebSocket endpoints for agent invocation (``routes.py``)
- Auth middleware (pluggable, API-key by default)
- Safe error formatting for all exception responses
- Extensible lifecycle hooks via :class:`~agent_service_maf.framework.registry.LifecycleHook`

All routes go through :class:`~agent_service_maf.framework.executor.AgentExecutor`
via the Phase 1 router defined in ``routes.py``.

CORS configuration:
- Development (``AGENT_ENVIRONMENT=development``): ``allow_origins=["*"]``
- Production: Uses ``interface.cors_origins`` from config (defaults to ``[]``)

Authentication:
- Controlled by ``interface.auth.enabled`` config flag.
- When enabled, validates ``X-API-Key`` header on all ``/agents`` endpoints.
- ``GET /health`` is always exempt.

Lifecycle hooks:
- Register via :meth:`~agent_service_maf.framework.registry.FrameworkRegistry.add_hook`
  before calling :func:`create_app`.
- Hooks run in registration order at startup, reverse order at shutdown.

Phase note:
    Gateway, MCP registry, and guardrails are Phase 2/3/5 concerns. In Phase 1
    they are initialised as ``None`` in ``app.state``. The
    :class:`~agent_service_maf.core.context.AgentExecutionContext` accepts ``None``
    for those fields.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import structlog
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from agent_service_maf.core.exceptions import (
    AgentFrameworkError,
    AgentTimeoutError,
    FrameworkNotFoundError,
)
from agent_service_maf.core.team_bundle import TeamBundle
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.interface_layer.auth import AgentAuthMiddleware, build_auth_middleware
from agent_service_maf.interface_layer.error_formatter import SafeErrorFormatter
from agent_service_maf.interface_layer.routes import api_router, system_router

logger = structlog.get_logger(__name__)


class _ProbeAccessLogFilter(logging.Filter):
    """Drop uvicorn access-log records for the k8s health/readiness probes.

    Liveness/readiness probes hit ``/health`` and ``/ready`` every few
    seconds, so their ``200 OK`` access lines drown out every real request.
    uvicorn formats access records with
    ``args = (client_addr, method, full_path, http_version, status_code)``,
    so we match on ``args[2]`` (the request path) and suppress those probes
    while keeping the access log for genuine traffic (``/api/v1/...``).
    """

    _PROBE_PATHS = frozenset({"/health", "/ready"})

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            return args[2] not in self._PROBE_PATHS
        return True


# Single shared instance: ``Filterer.addFilter`` dedupes by identity, so
# re-running ``create_app()`` (tests, factory reload) never stacks filters.
_probe_access_log_filter = _ProbeAccessLogFilter()

# ---------------------------------------------------------------------------
# Observability bootstrap
# ---------------------------------------------------------------------------
# Logging / tracing / metrics are delegated to the shared AgentStudio
# observability client (``observability_client_runtime``) — the same package
# config-service, kb-retrieval-service, and the Temporal workers use. It ships
# in-repo at ``src/common-py/observability/observability-client`` and is
# installed into the image by ``deploy/Dockerfile`` (it is NOT published to a
# package index).
#
# Env contract (platform-standard — identical to the workers):
#   LOG_LEVEL                                          -> min log level
#   AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH           -> app-log sink (/dev/stdout in k8s)
#   PHOENIX_COLLECTOR_ENDPOINT                         -> OTLP trace export (preferred on
#                                                        AKS; not rewritten by app-monitoring)
#   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT                 -> OTLP trace export fallback
#   AGENT_STUDIO_OBSERVABILITY_METRICS_OTLP_ENDPOINT /
#     OTEL_EXPORTER_OTLP_METRICS_ENDPOINT              -> OTLP metrics export
#   OTEL_SERVICE_NAME                                  -> service.name (traces + metrics)
#   AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT -> optional /metrics scrape port
# Any other ``ObservabilityLoggingConfig`` field can be set via
# ``AGENT_STUDIO_OBSERVABILITY_<FIELD>`` (read by the client itself).
#
# When the client is not installed (local ``make dev`` without the package, CI
# unit tests) we fall back to a structlog-only config that still applies the
# SecretRedactor and ``merge_contextvars`` — so secrets never leak and the
# per-request audit breadcrumbs bound in ``routes.py``
# (user_id / project_id / correlation_id) still appear in log output.
ASGITraceMiddleware: Any = None
LogLevel: Any = None
ObservabilityLoggingConfig: Any = None
configure_observability_logging: Any = None
_configure_observability_minimal: Any = None
_LOG_INGESTION_AVAILABLE = False

try:
    from observability_client_runtime import (  # pyright: ignore[reportMissingImports]
        ASGITraceMiddleware as _ASGITraceMiddleware,
    )
    from observability_client_runtime import (
        ObservabilityLoggingConfig as _ObservabilityLoggingConfig,
    )
    from observability_client_runtime import (
        configure_observability_logging as _configure_observability_logging,
    )
    from observability_client_runtime import (
        configure_observability_minimal as _configure_observability_minimal_impl,
    )

    # NOTE: LogLevel is NOT re-exported from the package root — it lives in the
    # logger_handler submodule. Importing it from ``observability_client_runtime``
    # raises ImportError and silently disables the whole SDK path (see the
    # try/except below), so import it from where it actually resolves.
    from observability_client_runtime.logger_handler import (
        LogLevel as _LogLevel,
    )

    ASGITraceMiddleware = _ASGITraceMiddleware
    LogLevel = _LogLevel
    ObservabilityLoggingConfig = _ObservabilityLoggingConfig
    configure_observability_logging = _configure_observability_logging
    _configure_observability_minimal = _configure_observability_minimal_impl
    _LOG_INGESTION_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised only when the SDK is absent
    pass


def _inject_secret_redactor() -> None:
    """Insert :class:`SecretRedactor` just before the renderer in the active
    structlog chain.

    The shared observability client builds its own processor list and has no
    knowledge of MAF's redactor, so we splice it in after configuration. Placed
    immediately before the (final) renderer it sees the fully-merged event dict
    — including contextvars and OTel trace fields — guaranteeing no configured
    pipeline ever emits an unredacted secret. Idempotent.
    """
    from agent_service_maf.gateway.secret_redactor import SecretRedactor

    cfg = structlog.get_config()
    procs = list(cfg["processors"])
    if any(isinstance(p, SecretRedactor) for p in procs):
        return
    procs.insert(max(len(procs) - 1, 0), SecretRedactor())
    structlog.configure(
        processors=procs,
        context_class=cfg["context_class"],
        logger_factory=cfg["logger_factory"],
        wrapper_class=cfg["wrapper_class"],
        cache_logger_on_first_use=cfg["cache_logger_on_first_use"],
    )


def _configure_fallback_logging() -> None:
    """structlog-only config for when the observability client is absent.

    JSON to stdout with level filtering and contextvar merging — no OTel traces
    or metrics. The SecretRedactor is added by :func:`_inject_secret_redactor`.
    """
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level_no = getattr(logging, level_name, logging.INFO)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level_no),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=False,
    )


def _resolve_otlp_traces_endpoint() -> str | None:
    """Pick the OTLP traces URL the observability client should use.

    On AKS, ``app-monitoring-webhook`` rewrites ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT``
    to the node-local Azure Monitor receiver (``<node-ip>:28331``). Legacy
    ``agent-service`` avoids that by exporting via ``PHOENIX_COLLECTOR_ENDPOINT``,
    which the webhook leaves untouched. MAF mirrors that precedence here, with a
    fallback to ``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_BEFORE_AUTO_INSTRUMENTATION``
    when only the hijacked OTEL var is present.
    """
    for key in (
        "PHOENIX_COLLECTOR_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_BEFORE_AUTO_INSTRUMENTATION",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return None


def _configure_observability() -> None:
    """Configure logging/tracing/metrics once at import time."""
    if _LOG_INGESTION_AVAILABLE and _configure_observability_minimal is not None:
        _configure_observability_minimal(
            log_file_path=os.environ.get("AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "/dev/stdout"),
            log_level=os.environ.get("LOG_LEVEL", "info"),
            otlp_traces_endpoint=_resolve_otlp_traces_endpoint(),
            otlp_logs_endpoint=(
                os.environ.get("AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT")
                or os.environ.get("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")
            ),
            metrics_otlp_endpoint=(
                os.environ.get("AGENT_STUDIO_OBSERVABILITY_METRICS_OTLP_ENDPOINT")
                or os.environ.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")
            ),
            metrics_service_name=os.environ.get("OTEL_SERVICE_NAME", "agent-service-maf"),
            prometheus_metrics_port=(
                int(port)
                if (port := os.environ.get("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT"))
                else None
            ),
        )
        # O1: stamp every span with the caller's AgentStudio project id so the
        # Phoenix Observability MCP can enforce per-project isolation. Must run
        # after the shared client installs the SDK TracerProvider above.
        try:
            from agent_service_maf.core.phoenix_tracing import (
                install_phoenix_project_stamping,
            )

            install_phoenix_project_stamping()
        except Exception:  # never let observability wiring break startup
            logger.warning("could not install phoenix project stamping", exc_info=True)
    else:
        _configure_fallback_logging()
        logger.info(
            "observability client not installed; using structlog fallback "
            "(JSON logs + secret redaction, no OTel traces/metrics)",
            hint="the container image installs it via deploy/Dockerfile",
        )
    # SecretRedactor is MAF-specific; splice it into whichever chain we configured.
    _inject_secret_redactor()


_configure_observability()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan — startup and shutdown.

    Startup sequence (post-migration):

    1. Pick a config source based on ``CONFIG_SOURCE``:
       :class:`RemoteConfigCache` for ``remote`` (with a
       :class:`ServiceAccountClient` for Keycloak), or
       :class:`FileConfigLoader` for ``file``.
    2. Wrap the source in a :class:`LazyTeamRegistry` with a post-build
       hook that connects MCP servers + starts the task manager — so the
       first request that materialises a bundle returns a fully wired
       resource without exposing ``connect_all`` semantics to the route
       layer.
    3. Pre-warm any teams listed in ``AGENT_WARM_TEAMS`` (optional). The
       registry is otherwise empty; bundles materialise on first request.
    4. Apply the ``AGENT_DEFAULT_TEAM`` override against materialised
       bundles (the override only takes effect for warmed-up teams; see
       below for the lazy variant).
    5. Wire :attr:`app.state` back-compat shims, then yield.

    Shutdown sequence iterates :meth:`all_bundles`, draining tasks →
    sessions → MCP → (gateway is owned by the bundle and closed
    implicitly when ``mcp_manager.disconnect_all`` completes). Only
    bundles that were actually materialised are torn down — the lazy
    registry naturally skips un-warmed teams.

    Args:
        app: The FastAPI application instance. Services are stored on
            ``app.state``.

    Yields:
        Control to the application for request handling.
    """
    start_time = time.time()

    import asyncio

    from agent_service_maf.config.file_loader import FileConfigLoader
    from agent_service_maf.config.remote_loader import RemoteConfigCache
    from agent_service_maf.config.service_auth import ServiceAccountClient
    from agent_service_maf.config.settings import settings as runtime_settings
    from agent_service_maf.core.team_registry_lazy import ConfigSource, LazyTeamRegistry

    logger.info(
        "Agent framework starting up",
        config_source=runtime_settings.CONFIG_SOURCE,
        remote_enabled=runtime_settings.remote_enabled,
    )

    app.state.framework_registry = FrameworkRegistry
    app.state.start_time = start_time

    # ---- Source selection (single-line branch on the flag) ----------------
    service_auth: ServiceAccountClient | None = None
    source: ConfigSource
    # Per-project Bifrost VK resolver — wired only in remote mode (file
    # mode has no config-service to fetch the VK from, and is the
    # test/dev escape hatch where the env-sourced api_key is still OK).
    project_vk_resolver: Any | None = None
    project_vk_http_client: httpx.AsyncClient | None = None
    if runtime_settings.remote_enabled:
        service_auth = ServiceAccountClient(
            issuer=runtime_settings.KEYCLOAK_INTERNAL_ISSUER,
            client_id=runtime_settings.KEYCLOAK_CLIENT_ID,
            client_secret=runtime_settings.KEYCLOAK_CLIENT_SECRET,
            timeout=runtime_settings.CONFIG_HTTP_TIMEOUT,
            refresh_leeway_seconds=runtime_settings.KEYCLOAK_TOKEN_REFRESH_LEEWAY_SECONDS,
        )
        source = RemoteConfigCache(
            auth=service_auth,
            ttl=runtime_settings.CONFIG_CACHE_TTL,
            max_size=runtime_settings.CONFIG_CACHE_MAX_SIZE,
        )
        app.state.service_auth = service_auth
        # Let the KB-retrieval function tool mint a Keycloak service JWT
        # (aud=agent-studio-api) for its outbound calls. kb-retrieval-service
        # sits behind the in-mesh mesh-require-jwt AuthorizationPolicy in the
        # JWT-gated agentstudio-services namespace; without a valid service
        # JWT the hop is denied by Envoy with 403 "RBAC: access denied".
        from agent_service_maf.tools.functions.kb_retrieve import set_kb_service_auth

        set_kb_service_auth(service_auth)
        # Build the VK resolver alongside the config source. The
        # resolver owns its own httpx.AsyncClient so its lifecycle is
        # independent of any other consumer of httpx in the lifespan
        # (RemoteConfigCache manages its own client internally).
        from agent_service_maf.gateway import ProjectVKResolver

        project_vk_http_client = httpx.AsyncClient(
            timeout=runtime_settings.CONFIG_HTTP_TIMEOUT,
        )
        project_vk_resolver = ProjectVKResolver(
            config_service_url=runtime_settings.CONFIG_SERVICE_URL,
            http_client=project_vk_http_client,
            ttl_seconds=runtime_settings.CONFIG_CACHE_TTL,
            service_auth=service_auth,
        )
        app.state.project_vk_resolver = project_vk_resolver
        logger.info(
            "project_vk_resolver_wired",
            config_service_url=runtime_settings.CONFIG_SERVICE_URL,
            ttl_seconds=runtime_settings.CONFIG_CACHE_TTL,
        )
    else:
        if runtime_settings.CONFIG_SOURCE == "remote":
            # Selected remote but URL / Keycloak isn't configured — log
            # the gap and fall through to file mode so the service still
            # starts.
            logger.warning(
                "CONFIG_SOURCE=remote but CONFIG_SERVICE_URL is empty; falling back to file source",
            )
        # Surface the half-configured file-mode case — CONFIG_SOURCE=file
        # but no AGENT_TEAMS_DIR / AGENT_CONFIG_PATH means the registry
        # will silently come up empty, which is almost never what an
        # operator intended.
        from agent_service_maf.config.file_loader import _legacy_env_warning

        _legacy_env_warning()
        source = FileConfigLoader()

    app.state.config_loader_source = source

    # ---- Model catalog ---------------------------------------------------
    # In remote mode, wire a ConfigServiceModelCatalog that maps catalog
    # UUIDs (sent by eval-worker / UI playground as
    # ``configOverrides.model``) into the Bifrost-routable gatewayModelId
    # via config-service's GET /models/{id}. In file/test mode we keep the
    # NoopModelCatalog (the routes already fall back to it on
    # ``_get_model_catalog`` when ``app.state.model_catalog`` is unset).
    if isinstance(source, RemoteConfigCache):
        from agent_service_maf.config.model_catalog import ConfigServiceModelCatalog

        app.state.model_catalog = ConfigServiceModelCatalog(source)
        logger.info("model_catalog_wired", impl="ConfigServiceModelCatalog")

    # ---- Post-build lifecycle hook ---------------------------------------
    # Every newly-materialised bundle goes through this hook so the route
    # layer never sees a half-wired resource. Connect MCP servers (or skip
    # entirely when mcp.lazy_connect=true) and start the task manager.
    async def _post_build_lifecycle(bundle: TeamBundle) -> None:
        if not bundle.healthy:
            return
        if bundle.mcp_manager is not None:
            # lazy_connect=true means "defer the connect until the first
            # tool call". Skipping connect_all() entirely here is the
            # whole point of the flag — running it and merely tolerating
            # failures still pays the connect wait on first
            # materialisation, which can hang or stall request latency.
            if bundle.config is not None and bundle.config.mcp.lazy_connect:
                logger.info(
                    "MCP connection deferred (lazy_connect=true)",
                    project_id=bundle.project_id,
                    team_id=bundle.team_id,
                )
            else:
                try:
                    connected = await bundle.mcp_manager.connect_all()
                    logger.info(
                        "MCP servers connected",
                        project_id=bundle.project_id,
                        team_id=bundle.team_id,
                        servers=connected,
                    )
                except Exception as exc:
                    bundle.healthy = False
                    bundle.startup_error = f"MCP connect failed: {exc}"
                    logger.error(
                        "MCP connection failed at first materialisation",
                        project_id=bundle.project_id,
                        team_id=bundle.team_id,
                        error=str(exc),
                    )
                    return
        if bundle.task_manager is not None:
            try:
                await bundle.task_manager.start()
            except Exception as exc:  # pragma: no cover - best effort
                logger.warning(
                    "task_manager.start failed",
                    project_id=bundle.project_id,
                    team_id=bundle.team_id,
                    error=str(exc),
                )

    team_registry = LazyTeamRegistry(
        source=source,
        post_build_hook=_post_build_lifecycle,
        vk_resolver=project_vk_resolver,
    )
    # Register the ``AGENT_DEFAULT_TEAM`` override *before* any
    # materialisation so even the first lazily-built bundle for that
    # team gets promoted to the project's default. Without this, the
    # very first ``add()`` (which TeamRegistry treats as "implicit
    # default if none set") wins and the operator's choice is silently
    # ignored.
    early_default = os.environ.get("AGENT_DEFAULT_TEAM", "").strip()
    if early_default:
        team_registry.set_explicit_default_team_id(early_default)
    app.state.teams = team_registry

    # ---- Optional warm-up of known-hot teams -----------------------------
    # The lazy registry is otherwise empty until the first request triggers
    # materialisation. AGENT_WARM_TEAMS lets operators pre-build a small
    # set so MCP / task managers are connected before serving traffic.
    warm_entries = list(runtime_settings.warm_team_entries())

    # File mode is the "testing escape hatch" — the universe of teams is
    # known synchronously, integration tests peek at
    # ``app.state.teams`` directly, and the pre-migration contract was
    # eager registration of every discovered team. Auto-add every
    # indexed team to the warm-up list so the file-mode runtime
    # semantics stay bit-identical to today. Remote mode keeps the
    # strict lazy behaviour described in the migration plan.
    auto_warm_fn = getattr(source, "known_team_keys", None)
    if callable(auto_warm_fn):
        try:
            file_pairs = [(pid, tid) for (pid, tid) in auto_warm_fn() if pid and tid]
        except Exception as exc:  # noqa: BLE001
            logger.warning("file_loader_known_keys_failed", error=str(exc))
            file_pairs = []
        existing = {entry for entry in warm_entries}
        for pair in file_pairs:
            if pair not in existing:
                warm_entries.append(pair)

    if warm_entries:
        results = await asyncio.gather(
            *(team_registry.get_or_load_team(pid, tid) for pid, tid in warm_entries),
            return_exceptions=True,
        )
        for (pid, tid), result in zip(warm_entries, results, strict=True):
            if isinstance(result, BaseException):
                logger.warning(
                    "warm_team_failed",
                    project_id=pid,
                    team_id=tid,
                    error_type=type(result).__name__,
                    error=str(result),
                )
            elif result is None:
                logger.warning(
                    "warm_team_not_found",
                    project_id=pid,
                    team_id=tid,
                )

    # ``set_explicit_default_team_id`` above captured the operator's
    # ``AGENT_DEFAULT_TEAM`` choice, and :meth:`LazyTeamRegistry.add`
    # already re-applies it (both ``default_team_id`` and
    # ``set_project_default``) the moment a matching bundle is added —
    # see ``team_registry_lazy.py:add``. The warm-up loop above calls
    # ``add()`` for every materialised bundle, so any post-warm-up
    # second pass would be redundant: in cases where the explicit
    # default is in the warmed set, ``add()`` already promoted it; in
    # cases where it isn't, the second pass would skip the promotion
    # anyway. Just log the final selection for operator visibility.
    if team_registry.default_team_id:
        logger.info("Default team selected", team_id=team_registry.default_team_id)

    # ---- Back-compat shims for code paths that still read app.state attrs
    default = team_registry.default()
    if default is not None:
        app.state.config = default.config
        app.state.config_loader = default.config_loader
        app.state.gateway = default.gateway
        app.state.mcp_manager = default.mcp_manager
        app.state.guardrails = default.guardrails
        app.state.session_manager = default.session_manager
    else:
        app.state.config = None
        app.state.config_loader = None
        app.state.gateway = None
        app.state.mcp_manager = None
        app.state.guardrails = None
        app.state.session_manager = None

    await FrameworkRegistry.run_startup_hooks(app)

    logger.info(
        "Agent framework started",
        teams=team_registry.all_ids(),
        default_team=team_registry.default_team_id,
        healthy=team_registry.healthy_ids(),
        protocols=["rest", "sse", "websocket"],
        registered_frameworks=FrameworkRegistry.list_frameworks(),
        config_source=runtime_settings.CONFIG_SOURCE,
        warm_team_count=len(warm_entries),
    )

    yield

    # -----------------------------------------------------------------------
    # Shutdown — reverse order of startup
    # -----------------------------------------------------------------------
    logger.info("Agent framework shutting down")

    # all_bundles() returns only materialised bundles — unwarmed teams
    # contribute nothing because they were never built.
    for bundle in team_registry.all_bundles() if team_registry else []:
        if bundle.task_manager is not None:
            try:
                await bundle.task_manager.close()
            except Exception as exc:  # pragma: no cover - best effort
                logger.warning(
                    "task_manager.close failed",
                    project_id=bundle.project_id,
                    team_id=bundle.team_id,
                    error=str(exc),
                )
        if bundle.session_manager is not None:
            try:
                await bundle.session_manager.stop()
            except Exception as exc:  # pragma: no cover - best effort
                logger.warning(
                    "session_manager.stop failed",
                    project_id=bundle.project_id,
                    team_id=bundle.team_id,
                    error=str(exc),
                )
        if bundle.mcp_manager is not None:
            try:
                await bundle.mcp_manager.disconnect_all()
            except Exception as exc:  # pragma: no cover - best effort
                logger.warning(
                    "mcp_manager.disconnect_all failed",
                    project_id=bundle.project_id,
                    team_id=bundle.team_id,
                    error=str(exc),
                )

    # Release the long-lived HTTP client inside the remote cache so the
    # pooled keep-alive connections are torn down cleanly instead of
    # lingering until process exit (file source has no equivalent).
    source_aclose = getattr(source, "aclose", None)
    if callable(source_aclose):
        try:
            await source_aclose()
        except Exception as exc:  # pragma: no cover - best effort
            logger.warning(
                "config_loader_source.aclose failed",
                error_type=type(exc).__name__,
                error=str(exc),
            )

    # Close the VK resolver's dedicated HTTP client (only present in
    # remote mode). File mode never constructs one.
    if project_vk_http_client is not None:
        try:
            await project_vk_http_client.aclose()
        except Exception as exc:  # pragma: no cover - best effort
            logger.warning(
                "project_vk_http_client.aclose failed",
                error_type=type(exc).__name__,
                error=str(exc),
            )

    await FrameworkRegistry.run_shutdown_hooks(app)

    logger.info("Agent framework stopped")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Registers all middleware, exception handlers, and the Phase 1 router.
    This factory function is the primary entry point — call it once at startup.

    Returns:
        Configured :class:`fastapi.FastAPI` application instance.

    Example:
        >>> app = create_app()
        >>> import uvicorn
        >>> uvicorn.run(app, host="0.0.0.0", port=8000)
    """
    app = FastAPI(
        title="Agent Framework",
        description=(
            "A pluggable, protocol-agnostic agent orchestration service. "
            "Supports REST, SSE, and WebSocket protocols."
        ),
        version="0.1.0",
        lifespan=lifespan,
    )

    # Silence the constant /health + /ready probe access-log spam. Added here
    # (not main()) so it also applies under the Dockerfile's `uvicorn --factory`
    # entrypoint; the filter survives uvicorn's own dictConfig because that
    # only resets handlers, never filters.
    logging.getLogger("uvicorn.access").addFilter(_probe_access_log_filter)

    # -----------------------------------------------------------------------
    # CORS middleware
    # -----------------------------------------------------------------------
    is_dev = os.environ.get("AGENT_ENVIRONMENT", "").lower() == "development"
    cors_origins: list[str] = ["*"] if is_dev else []

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    # -----------------------------------------------------------------------
    # Authentication middleware
    # -----------------------------------------------------------------------
    # Build auth provider from environment:
    #   AGENT_INTERFACE__AUTH__ENABLED  -> true | false
    #   AGENT_INTERFACE__AUTH__SCHEME   -> api_key | gateway_identity
    #   AGENT_INTERFACE__AUTH__API_KEYS -> comma-separated, only used when scheme=api_key
    _auth_enabled = os.environ.get("AGENT_INTERFACE__AUTH__ENABLED", "false").lower() == "true"
    _auth_scheme = os.environ.get("AGENT_INTERFACE__AUTH__SCHEME", "api_key").strip() or "api_key"
    _api_keys_raw = os.environ.get("AGENT_INTERFACE__AUTH__API_KEYS", "")
    _api_keys = [k.strip() for k in _api_keys_raw.split(",") if k.strip()] if _api_keys_raw else []

    auth_provider = build_auth_middleware(
        enabled=_auth_enabled,
        scheme=_auth_scheme,
        api_keys=_api_keys,
    )
    app.add_middleware(AgentAuthMiddleware, auth_provider=auth_provider)
    # Stash the provider on app.state so the WebSocket routes can reuse it
    # at handshake time. AgentAuthMiddleware is pure-ASGI HTTP middleware and
    # passes WS scopes straight through — WS connections must authenticate
    # themselves before calling websocket.accept().
    app.state.auth_provider = auth_provider

    # -----------------------------------------------------------------------
    # Observability trace middleware
    # -----------------------------------------------------------------------
    if ASGITraceMiddleware is not None:
        app.add_middleware(ASGITraceMiddleware)

    # -----------------------------------------------------------------------
    # Exception handlers
    # -----------------------------------------------------------------------

    @app.exception_handler(FrameworkNotFoundError)  # type: ignore[misc]
    async def handle_framework_not_found(
        request: Request,
        exc: FrameworkNotFoundError,
    ) -> JSONResponse:
        """Return HTTP 404 for FrameworkNotFoundError with sanitized details.

        Args:
            request: The incoming request.
            exc: The exception that was raised.

        Returns:
            JSON 404 response with sanitized error details.
        """
        safe = SafeErrorFormatter.format_error(
            exc,
            is_dev=getattr(app, "debug", False),
            correlation_id="",
        )
        return JSONResponse(status_code=404, content=safe)

    @app.exception_handler(AgentTimeoutError)  # type: ignore[misc]
    async def handle_agent_timeout(
        request: Request,
        exc: AgentTimeoutError,
    ) -> JSONResponse:
        """Return HTTP 504 Gateway Timeout for ``AgentTimeoutError``.

        Registered BEFORE the generic ``AgentFrameworkError`` handler so
        the more specific subclass match wins (FastAPI dispatches by
        exact ``type(exc) in handlers`` first, then walks the MRO —
        having both handlers keeps the semantics explicit regardless).

        504 is the right status for this exception: it represents a
        downstream timeout (LLM / MCP / tool call exceeding
        ``agent.timeout_seconds``), not an internal MAF failure. The
        previous behaviour — falling through to the 500 handler —
        misclassified timeouts as internal errors and broke client
        retry/monitoring logic that distinguishes the two.

        Args:
            request: The incoming request.
            exc: The :class:`AgentTimeoutError` that was raised.

        Returns:
            JSON 504 response with sanitized error details.
        """
        safe = SafeErrorFormatter.format_error(
            exc,
            is_dev=getattr(app, "debug", False),
            correlation_id="",
        )
        return JSONResponse(status_code=504, content=safe)

    @app.exception_handler(AgentFrameworkError)  # type: ignore[misc]
    async def handle_framework_error(
        request: Request,
        exc: AgentFrameworkError,
    ) -> JSONResponse:
        """Return HTTP 500 for AgentFrameworkError subclasses with sanitized details.

        Args:
            request: The incoming request.
            exc: The exception that was raised.

        Returns:
            JSON 500 response with sanitized error details.
        """
        safe = SafeErrorFormatter.format_error(
            exc,
            is_dev=getattr(app, "debug", False),
            correlation_id="",
        )
        return JSONResponse(status_code=500, content=safe)

    @app.exception_handler(Exception)  # type: ignore[misc]
    async def handle_generic_error(
        request: Request,
        exc: Exception,
    ) -> JSONResponse:
        """Return HTTP 500 for unexpected exceptions with sanitized details.

        Args:
            request: The incoming request.
            exc: The unexpected exception.

        Returns:
            JSON 500 response with sanitized details (no stack trace in production).
        """
        safe = SafeErrorFormatter.format_error(
            exc,
            is_dev=getattr(app, "debug", False),
            correlation_id="",
        )
        return JSONResponse(status_code=500, content=safe)

    # -----------------------------------------------------------------------
    # Routers
    # -----------------------------------------------------------------------
    # api_router: project-scoped resource routes mounted under /api/v1.
    #   Provides:
    #     GET    /api/v1/projects/{project_id}/teams
    #     GET    /api/v1/projects/{project_id}/teams/{team_id}
    #     POST   /api/v1/projects/{project_id}/teams/{team_id}/invoke
    #     POST   /api/v1/projects/{project_id}/teams/{team_id}/invoke/async
    #     POST   /api/v1/projects/{project_id}/teams/{team_id}/stream
    #     WS     /api/v1/projects/{project_id}/teams/{team_id}/ws
    #     GET    /api/v1/projects/{project_id}/agents
    #     GET    /api/v1/projects/{project_id}/agents/{agent_id}/capabilities
    #     POST   /api/v1/projects/{project_id}/agents/invoke
    #     POST   /api/v1/projects/{project_id}/agents/stream
    #     POST   /api/v1/projects/{project_id}/agents/{agent_id}/invoke
    #     POST   /api/v1/projects/{project_id}/agents/{agent_id}/invoke/async
    #     POST   /api/v1/projects/{project_id}/agents/{agent_id}/stream
    #     WS     /api/v1/projects/{project_id}/agents/{agent_id}/ws
    #     GET    /api/v1/projects/{project_id}/tasks/{task_id}
    #     DELETE /api/v1/projects/{project_id}/tasks/{task_id}
    # system_router: un-prefixed probe routes — currently GET /health.
    app.include_router(api_router, prefix="/api/v1")
    app.include_router(system_router)

    return app


def main() -> None:
    """Entry point for running the HTTP server.

    Uses uvicorn with default settings. Override host/port via
    ``AGENT_INTERFACE__HOST`` and ``AGENT_INTERFACE__PORT`` env vars.
    """
    app = create_app()
    host = os.environ.get("AGENT_INTERFACE__HOST", "0.0.0.0")
    port_str = os.environ.get("AGENT_INTERFACE__PORT", "8000")
    port = int(port_str)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
