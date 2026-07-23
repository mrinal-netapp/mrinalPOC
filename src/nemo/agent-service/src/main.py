"""Agent Service -- FastAPI application for agent invocation."""

import asyncio
import contextlib
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import AsyncGenerator
from urllib.parse import quote

import httpx
from opentelemetry import trace as otel_trace
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis.asyncio import Redis
from sse_starlette.sse import EventSourceResponse

from .auth import get_user_context, validate_project_access
from .config import settings
from .config_cache import AgentConfigCache
from .redis_factory import create_async_redis_client
from .agent_factory import AgentFactory
from .context_manager import (
    ContextManager,
    MemoryConfig,
    SingleTurnOverflowError,
    is_context_overflow_error,
    resolve_context_window,
    resolve_output_reservation,
)
from .history_reconstructor import ReconstructedMessage, default_reconstructor
from .kb_retrieval import KBRetrievalClient
from .team_factory import TeamFactory
from .mcp_pool import MCPConnectionPool
from .service_auth import ServiceAccountClient
from .session_store import SessionStore, SummaryStore
from .summarizer import Summarizer, get_summarizer
from .task_manager import TaskManager
from .tracing import (
    agno_team_nest_under_current_span,
    agentstudio_phoenix_project_id,
    get_phoenix_api_url,
    init_tracing,
    phoenix_project_scope,
    shutdown_tracing,
    tracing_enabled,
)
from .activity_log import activity, request_id as activity_request_id
from observability_client_runtime import ASGITraceMiddleware, configure_observability_minimal, get_logger

logger = get_logger()

_tracer = otel_trace.get_tracer("agent-service.invoke")


class _HealthAccessLogFilter(logging.Filter):
    """Suppress uvicorn access logs for /health and /ready unless DEBUG is set."""

    def filter(self, record: logging.LogRecord) -> bool:
        if settings.DEBUG:
            return True
        if record.name != "uvicorn.access":
            return True
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            path = (args[2] or "").split("?")[0]
            if path in ("/health", "/ready", "/metrics"):
                return False
        return True


# --- Request / Response models ---


class AttachmentItem(BaseModel):
    filename: str
    mimeType: str
    content: str


_MAX_ATTACHMENTS = 5
_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024


class InvokeRequest(BaseModel):
    message: str
    sessionId: str | None = None
    context: dict | None = None
    attachments: list[AttachmentItem] | None = None
    modelId: str | None = None


async def _apply_model_override(
    body: InvokeRequest,
    config: dict,
    project_id: str,
) -> dict:
    """If the invoke request carries a modelId override, validate and apply it.

    For agent configs: overrides config["modelId"].
    Returns a (possibly shallow-copied) config dict.
    """
    if not body.modelId:
        return config
    model_info = await agent_factory.model_resolver.resolve_model_info(
        project_id, body.modelId,
    )
    if not model_info:
        raise HTTPException(404, f"Override model {body.modelId} not found in project")
    if model_info.get("modelType") == "embedding":
        raise HTTPException(400, "Cannot use an embedding model for agent invocation")
    activity(
        logger, "model_override",
        scope="agent", project_id=project_id, model_id=body.modelId,
        model_type=model_info.get("modelType") or "llm",
    )
    return {**config, "modelId": body.modelId}


async def _apply_team_model_override(
    body: InvokeRequest,
    team_config: dict,
    project_id: str,
) -> dict:
    """If the invoke request carries a modelId override, validate and apply it
    to the team manager model."""
    if not body.modelId:
        return team_config
    model_info = await agent_factory.model_resolver.resolve_model_info(
        project_id, body.modelId,
    )
    if not model_info:
        raise HTTPException(404, f"Override model {body.modelId} not found in project")
    if model_info.get("modelType") == "embedding":
        raise HTTPException(400, "Cannot use an embedding model for team invocation")
    activity(
        logger, "model_override",
        scope="team_manager", project_id=project_id, model_id=body.modelId,
        model_type=model_info.get("modelType") or "llm",
    )
    manager = dict(team_config.get("manager") or {})
    manager["modelId"] = body.modelId
    return {**team_config, "manager": manager}


class CitationItem(BaseModel):
    source: str
    documentId: str | None = None
    downloadUrl: str | None = None
    knowledgeBaseId: str | None = None
    knowledgeBaseName: str | None = None
    score: float | None = None


class UsageItem(BaseModel):
    promptTokens: int | None = None
    completionTokens: int | None = None
    totalTokens: int | None = None


class InvokeResponse(BaseModel):
    response: str
    sessionId: str
    latencyMs: int | None = None
    modelName: str | None = None
    citations: list[CitationItem] | None = None
    usage: UsageItem | None = None


class AsyncInvokeResponse(BaseModel):
    taskId: str


class TaskStatusResponse(BaseModel):
    status: str
    result: dict | None = None
    error: str | None = None


# --- Globals initialised in lifespan ---

redis_client: Redis
service_auth: ServiceAccountClient
config_cache: AgentConfigCache
agent_factory: AgentFactory
team_factory: TeamFactory
mcp_pool: MCPConnectionPool
session_store: SessionStore
summary_store: SummaryStore
context_manager: ContextManager
task_manager: TaskManager
kb_http_client: httpx.AsyncClient
_invoke_semaphore: asyncio.Semaphore


def _pg_url() -> str:
    """Convert connection string to psycopg v3 dialect required by agno 2.5+."""
    url = settings.POSTGRES_URL
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _extract_structured_output(response_text: str) -> dict | None:
    """Parse agent response as JSON, handling markdown code block wrappers."""
    import json as _json
    try:
        return _json.loads(response_text)
    except (ValueError, TypeError):
        pass
    stripped = response_text.strip()
    if stripped.startswith("```json"):
        stripped = stripped[7:]
    elif stripped.startswith("```"):
        stripped = stripped[3:]
    if stripped.endswith("```"):
        stripped = stripped[:-3]
    stripped = stripped.strip()
    try:
        return _json.loads(stripped)
    except (ValueError, TypeError):
        return None


def _extract_usage(source: object | None) -> dict | None:
    if source is None:
        return None
    metrics = getattr(source, "metrics", None)
    if metrics is None and isinstance(source, dict):
        metrics = source.get("metrics")
    if metrics is None:
        return None
    data = metrics if isinstance(metrics, dict) else getattr(metrics, "__dict__", {})
    if not isinstance(data, dict):
        return None
    prompt = data.get("input_tokens")
    completion = data.get("output_tokens")
    total = data.get("total_tokens")
    if prompt is None and completion is None and total is None:
        return None
    return {
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
    }


_BANNER = "=" * 72
_SECTION = "-" * 52


async def _periodic_status_report(interval: int) -> None:
    """Background task that logs a visual status report of cached agents,
    MCP pool connections, and system health at a regular interval.
    Also triggers idle-connection eviction in the MCP pool."""
    if interval <= 0:
        logger.info("Periodic status report disabled (interval=%d)", interval)
        return
    logger.info(
        "Periodic status report started (interval=%ds, mcp_idle_ttl=%ds)",
        interval, settings.MCP_IDLE_TTL,
    )
    cycle = 0
    while True:
        try:
            await asyncio.sleep(interval)
            cycle += 1

            evicted = await mcp_pool.evict_idle()

            cache_snap = config_cache.status_snapshot()
            pool_snap = mcp_pool.status_snapshot()

            lines = [
                "",
                _BANNER,
                f"  AGENT SERVICE STATUS REPORT  (cycle #{cycle})",
                _BANNER,
                "",
                f"  Config Cache  (ttl={cache_snap['ttl_seconds']}s"
                f"  size={cache_snap['cache_size']}/{cache_snap['cache_max']}"
                f"  hits={cache_snap['total_hits']}"
                f"  misses={cache_snap['total_misses']}"
                f"  refreshes={cache_snap['total_refreshes']}"
                f"  hit_rate={cache_snap['hit_rate_pct']}%)",
                _SECTION,
            ]

            if cache_snap["cached_agents"]:
                lines.append(
                    f"  {'Agent Key':<40} {'Name':<20} {'Model':<20} {'Hits':>5} {'Idle':>7}"
                )
                lines.append(f"  {'-'*40} {'-'*20} {'-'*20} {'-'*5} {'-'*7}")
                for a in cache_snap["cached_agents"]:
                    lines.append(
                        f"  {a['key']:<40} {(a['name'] or '-'):<20} "
                        f"{(a['model'] or '-'):<20} {a['accesses']:>5} "
                        f"{a['idle_seconds']:>6.0f}s"
                    )
            else:
                lines.append("  (no agents currently cached)")

            lines.append("")
            idle_ttl_str = f"{pool_snap['idle_ttl']}s" if pool_snap['idle_ttl'] > 0 else "disabled"
            lines.append(
                f"  MCP Pool  (size={pool_snap['pool_size']}"
                f"  idle_ttl={idle_ttl_str})"
            )
            lines.append(_SECTION)

            if pool_snap["connections"]:
                lines.append(
                    f"  {'Server ID':<20} {'Name':<25} {'Health':<12} "
                    f"{'Hits':>5} {'Fails':>5} {'Idle':>7} {'Age':>8}"
                )
                lines.append(
                    f"  {'-'*20} {'-'*25} {'-'*12} "
                    f"{'-'*5} {'-'*5} {'-'*7} {'-'*8}"
                )
                for c in pool_snap["connections"]:
                    health_tag = c.get("health", "?")
                    err_suffix = ""
                    if c.get("last_error"):
                        err_suffix = f"  err={c['last_error'][:60]}"
                    lines.append(
                        f"  {c['server_id']:<20} {c['name']:<25} "
                        f"{health_tag:<12} "
                        f"{c['accesses']:>5} "
                        f"{c.get('consecutive_failures', 0):>5} "
                        f"{c['idle_seconds']:>6.0f}s "
                        f"{c['age_seconds']:>7.0f}s"
                        f"{err_suffix}"
                    )
            else:
                lines.append("  (no MCP connections active)")

            if evicted:
                lines.append("")
                lines.append(f"  Evicted MCP connections: {', '.join(evicted)}")

            resolver = agent_factory.model_resolver
            mi_cache = resolver._model_info_cache
            mc_cache = resolver._model_class_cache
            kb_cache = agent_factory._kb_metadata_cache
            lines.append("")
            lines.append(
                f"  Factory Lookup Caches"
                f"  (model_info: {len(mi_cache)}/{mi_cache.maxsize}"
                f"  ttl={settings.MODEL_INFO_CACHE_TTL}s"
                f"  |  model_class: {len(mc_cache)}/{mc_cache.maxsize}"
                f"  |  kb_metadata: {len(kb_cache)}/{kb_cache.maxsize}"
                f"  ttl={settings.KB_METADATA_CACHE_TTL}s)"
            )
            lines.append(_SECTION)
            if mi_cache:
                for key in list(mi_cache):
                    val = mi_cache.get(key)
                    if val:
                        lines.append(
                            f"    model_info  {key:<35} "
                            f"name={val.get('displayName') or val.get('name', '?')}"
                        )
            if mc_cache:
                for key in list(mc_cache):
                    val = mc_cache.get(key)
                    if val:
                        lines.append(
                            f"    model_class {key:<35} "
                            f"id={val.get('id', '?')} name={val.get('displayName') or val.get('name', '?')}"
                        )
            if kb_cache:
                for key in list(kb_cache):
                    val = kb_cache.get(key)
                    if val:
                        names = [m.get("name", "?") for m in val]
                        lines.append(
                            f"    kb_meta     {key:<35} kbs={names}"
                        )
            if not mi_cache and not kb_cache:
                lines.append("  (both caches empty)")

            lines.append("")
            lines.append(_BANNER)

            logger.info("\n".join(lines))

        except asyncio.CancelledError:
            logger.info("Periodic status report stopped")
            return
        except Exception:
            logger.exception("Error in periodic status report")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    global redis_client, service_auth, config_cache, agent_factory
    global team_factory, mcp_pool, session_store, task_manager
    global kb_http_client, _invoke_semaphore
    global summary_store, context_manager

    os.environ.setdefault("AGNO_TELEMETRY", "false")
    os.environ.setdefault("PHI_TELEMETRY", "false")
    os.environ.setdefault("AGNO_MONITORING", "false")

    redis_client = create_async_redis_client(settings)

    service_auth = ServiceAccountClient(
        issuer=settings.KEYCLOAK_INTERNAL_ISSUER,
        client_id=settings.KEYCLOAK_CLIENT_ID,
        client_secret=settings.KEYCLOAK_CLIENT_SECRET,
    )

    config_cache = AgentConfigCache(
        config_service_url=settings.CONFIG_SERVICE_URL,
        service_auth=service_auth,
        ttl_seconds=settings.CONFIG_CACHE_TTL,
        max_size=settings.CONFIG_CACHE_MAX_SIZE,
    )

    mcp_pool = MCPConnectionPool(idle_ttl=settings.MCP_IDLE_TTL)

    kb_http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(
            settings.KB_SEARCH_TIMEOUT_SECONDS,
            connect=settings.KB_SEARCH_CONNECT_TIMEOUT_SECONDS,
        )
    )
    kb_client = KBRetrievalClient(kb_http_client, settings.KB_RETRIEVAL_URL)
    logger.info("KB retrieval client created: %s", settings.KB_RETRIEVAL_URL)

    shared_db = None
    try:
        from agno.db.postgres import PostgresDb
        from sqlalchemy import create_engine

        _pg_engine = create_engine(
            _pg_url(),
            pool_size=settings.DB_POOL_SIZE,
            max_overflow=settings.DB_MAX_OVERFLOW,
            pool_pre_ping=True,
        )
        shared_db = PostgresDb(
            db_engine=_pg_engine,
            session_table="agent_sessions",
        )
        logger.info(
            "Shared PostgresDb instance created (pool_size=%d, max_overflow=%d)",
            settings.DB_POOL_SIZE, settings.DB_MAX_OVERFLOW,
        )
    except Exception as e:
        logger.warning("PostgresDb unavailable (%s); agent sessions will not persist", e)

    agent_factory = AgentFactory(
        mcp_pool,
        kb_client=kb_client,
        http_client=kb_http_client,
        config_service_url=settings.CONFIG_SERVICE_URL,
        service_auth=service_auth,
        shared_db=shared_db,
    )
    team_factory = TeamFactory(agent_factory, config_cache)
    session_store = SessionStore(
        redis_client,
        session_ttl=settings.SESSION_TTL,
        max_messages=settings.SESSION_MAX_MESSAGES,
    )
    summary_store = SummaryStore(redis_client, session_ttl=settings.SESSION_TTL)
    summarizer = get_summarizer()
    context_manager = ContextManager(
        history_reconstructor=default_reconstructor,
        summary_store=summary_store,
        summarizer=summarizer,
    )
    task_manager = TaskManager(
        redis_client,
        result_ttl=settings.TASK_RESULT_TTL,
        running_ttl=settings.RUNNING_TASK_TTL,
    )
    _invoke_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_INVOCATIONS)

    init_tracing()

    # Initialise shared observability client lib AFTER init_tracing() so the
    # RED span processor attaches to the Phoenix TracerProvider (not a duplicate one).
    # OTLP trace export is intentionally disabled here — tracing.py handles it
    # via PHOENIX_COLLECTOR_ENDPOINT → OTel collector → Phoenix.
    configure_observability_minimal(
        log_file_path=os.getenv(
            "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/agent-service.jsonl"
        ),
        log_level=os.getenv("LOG_LEVEL", "info"),
        otlp_traces_endpoint=None,  # tracing.py manages OTLP via PHOENIX_COLLECTOR_ENDPOINT
        metrics_service_name="agent-service",
        prometheus_metrics_port=int(
            os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT", "9090")
        ),
        enable_auto_instrumentation=False,  # AgnoInstrumentor already wired in tracing.py
    )
    # Re-attach the health-endpoint filter to uvicorn.access after the stdlib
    # bridge has replaced basicConfig's root handler.
    logging.getLogger("uvicorn.access").addFilter(_HealthAccessLogFilter())

    t0 = time.monotonic()
    agent_factory.warm_imports()
    logger.info("Import warmup completed in %.1fs", time.monotonic() - t0)

    # The ``litellm`` Python SDK is an upstream dependency of Agno's
    # ``agno.models.litellm.LiteLLM`` class — AgentStudio doesn't talk to
    # LiteLLM directly; all inference goes through the Bifrost gateway.
    # Setting ``drop_params=True`` tells the SDK to silently drop unsupported
    # provider params instead of raising, so e.g. Vertex Claude doesn't reject
    # requests that include both temperature and top_p.
    import litellm as _litellm_sdk
    _litellm_sdk.drop_params = True
    logger.info(
        "Agno litellm SDK: drop_params=True (unsupported provider params will be "
        "silently dropped instead of raising errors)"
    )

    logger.info(
        "Agent Service started (max_concurrent=%d, session_max_msgs=%d, running_task_ttl=%ds "
        "activity_http_log=%s)",
        settings.MAX_CONCURRENT_INVOCATIONS,
        settings.SESSION_MAX_MESSAGES,
        settings.RUNNING_TASK_TTL,
        settings.ACTIVITY_HTTP_LOG,
    )

    status_task = asyncio.create_task(
        _periodic_status_report(
            interval=settings.STATUS_REPORT_INTERVAL,
        )
    )

    yield

    await shutdown_tracing()

    status_task.cancel()
    try:
        await status_task
    except asyncio.CancelledError:
        pass
    await kb_http_client.aclose()
    await mcp_pool.close_all()
    await redis_client.aclose()
    logger.info("Agent Service shut down")


app = FastAPI(title="Agent Service", lifespan=lifespan)


@app.middleware("http")
async def activity_http_middleware(request: Request, call_next):
    """Assign X-Request-ID and log each request (duration, status) for debugging."""
    rid = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = rid
    t0 = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        if settings.ACTIVITY_HTTP_LOG:
            duration_ms = (time.monotonic() - t0) * 1000
            logger.info(
                "[activity] http | method=%s path=%s status=exception duration_ms=%.1f request_id=%s",
                request.method,
                request.url.path,
                duration_ms,
                rid,
            )
        raise
    duration_ms = (time.monotonic() - t0) * 1000
    path = request.url.path
    noise = path in ("/health", "/ready", "/metrics") and not settings.DEBUG
    if settings.ACTIVITY_HTTP_LOG and not noise:
        logger.info(
            "[activity] http | method=%s path=%s status=%s duration_ms=%.1f request_id=%s",
            request.method,
            path,
            response.status_code,
            duration_ms,
            rid,
        )
    response.headers["X-Request-ID"] = rid
    return response


app.add_middleware(ASGITraceMiddleware)

# --- Health endpoints ---


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    try:
        await redis_client.ping()
        return {"status": "ready"}
    except Exception:
        return JSONResponse({"status": "not ready"}, status_code=503)


# --- Helpers ---


def _validate_attachments(attachments: list[AttachmentItem] | None) -> None:
    """Raise HTTPException if attachments exceed limits."""
    if not attachments:
        return
    if len(attachments) > _MAX_ATTACHMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many attachments ({len(attachments)}). Maximum is {_MAX_ATTACHMENTS}.",
        )
    for att in attachments:
        size = len(att.content.encode("utf-8"))
        if size > _MAX_ATTACHMENT_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Attachment '{att.filename}' is too large ({size} bytes). Maximum is {_MAX_ATTACHMENT_BYTES}.",
            )


def _prepend_attachment_context(message: str, attachments: list[AttachmentItem] | None) -> str:
    """Prepend attachment content as structured context blocks."""
    if not attachments:
        return message
    blocks: list[str] = []
    for att in attachments:
        blocks.append(
            f"<attachment filename=\"{att.filename}\" type=\"{att.mimeType}\">\n"
            f"{att.content}\n"
            f"</attachment>"
        )
    prefix = "\n\n".join(blocks)
    return f"{prefix}\n\n{message}"


def _to_agno_messages(messages: list[ReconstructedMessage]) -> list:
    """Convert internal ReconstructedMessage list into Agno Message list.

    Imported lazily to avoid Agno import at module load time.
    """
    from agno.models.message import Message  # type: ignore

    out: list = []
    for m in messages:
        kwargs: dict = {"role": m.role, "content": m.content}
        if m.tool_calls:
            kwargs["tool_calls"] = m.tool_calls
        if m.tool_call_id:
            kwargs["tool_call_id"] = m.tool_call_id
        out.append(Message(**kwargs))
    return out


async def _prepare_context_managed_input(
    agent: object,
    user_message: str,
    owner_kind: str,  # "agent" or "team"
    owner_id: str,
    user_id: str,
    session_id: str,
) -> tuple[list, "ContextPrepareResult"]:
    """Build an Agno-ready List[Message] using ContextManager.

    Returns (agno_messages, prepare_result). prepare_result carries the
    PreparedContext and the internal ReconstructedMessage list — the
    latter is needed by the reactive-retry path which calls
    context_manager.aggressive_trim on it.
    """
    provider = getattr(agent, "_provider", None)
    model_name = getattr(agent, "_model_name", None)
    explicit_ctx = getattr(agent, "_context_window", None)
    context_window, ctx_source = resolve_context_window(explicit_ctx, provider)

    memory_type = getattr(agent, "_memory_type", "none")
    memory_config_raw = getattr(agent, "_memory_config_raw", {}) or {}
    memory_config = MemoryConfig.from_dict(
        memory_config_raw, memory_type=memory_type, provider=provider,
    )

    output_reservation = resolve_output_reservation(
        agent_max_tokens=getattr(agent, "_agent_max_tokens", None),
        model_max_output_tokens=getattr(agent, "_model_max_output_tokens", None),
        supports_extended_output=bool(getattr(agent, "_supports_extended_output", False)),
        has_outcome_schema=bool(getattr(agent, "_has_outcome_schema", False)),
    )

    system_prompt = getattr(agent, "_instructions_text", "") or ""

    # Tool schemas text — Phase 1: rough estimate via tool count.
    # Phase 2 will compute exact tool-schema tokens via Agno introspection.
    loaded_mcp_ids = getattr(agent, "_loaded_mcp_server_ids", []) or []
    has_tools = bool(getattr(agent, "_has_tools", False)) or bool(loaded_mcp_ids)
    # Conservative placeholder: 500 tokens per loaded MCP server. The
    # token counter then estimates from this string's length.
    tool_schemas_text = " ".join(["<tool/>"] * len(loaded_mcp_ids) * 200) if has_tools else ""

    history_records = await session_store.get_session_messages(owner_id, user_id, session_id)

    prepared = await context_manager.prepare(
        owner_kind=owner_kind,  # type: ignore[arg-type]
        owner_id=owner_id,
        user_id=user_id,
        session_id=session_id,
        system_prompt=system_prompt,
        tool_schemas_text=tool_schemas_text,
        user_msg_content=user_message,
        history_records=history_records,
        provider=provider,
        model=model_name,
        context_window=context_window,
        context_window_source=ctx_source,
        memory_config=memory_config,
        has_tools=has_tools,
        output_reservation=output_reservation,
    )

    activity(
        logger,
        "context_manager_prepared",
        entity_id=owner_id,
        session_id=session_id,
        strategy=prepared.strategy_used,
        est_input_tokens=prepared.est_input_tokens,
        context_window=prepared.context_window,
        context_window_source=prepared.context_window_source,
        trimmed_turn_count=prepared.trimmed_turn_count,
        history_records=len(history_records),
        provider=provider,
        model=model_name,
    )

    return _to_agno_messages(prepared.messages), _ContextPrepareResult(
        prepared=prepared,
        internal_messages=prepared.messages,
    )


@dataclass
class _ContextPrepareResult:
    prepared: object  # PreparedContext
    internal_messages: list  # list[ReconstructedMessage]


def _check_user_message_size(message: str) -> None:
    """Reject oversized user messages before they reach tokenization/LLM."""
    size = len(message.encode("utf-8"))
    if size > settings.MAX_USER_MESSAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"User message exceeds maximum size "
                f"({size} bytes > {settings.MAX_USER_MESSAGE_BYTES} bytes)."
            ),
        )


async def _build_arun_input(
    agent: object,
    user_message: str,
    owner_kind: str,
    owner_id: str,
    user_id: str,
    session_id: str,
) -> tuple[list, "_ContextPrepareResult"]:
    """Resolve the Agno message list to pass to ``arun()`` plus the
    prepared-context handle used by the reactive-retry path.

    Raises HTTPException(413) on SingleTurnOverflowError (single
    message + system prompt already exceeds the model's context
    window — no trimming can help).
    """
    _check_user_message_size(user_message)
    try:
        return await _prepare_context_managed_input(
            agent, user_message, owner_kind, owner_id, user_id, session_id,
        )
    except SingleTurnOverflowError as exc:
        raise HTTPException(status_code=413, detail=str(exc))


def _retry_input_for_overflow(
    cm_result: "_ContextPrepareResult",
) -> list:
    """Aggressively-trimmed Agno message list for reactive retry on
    context-overflow errors."""
    retrimmed = context_manager.aggressive_trim(cm_result.internal_messages)
    return _to_agno_messages(retrimmed)


def _maybe_enqueue_summary_refresh(
    cm_result: "_ContextPrepareResult",
    *,
    owner_kind: str,
    owner_id: str,
    user_id: str,
    session_id: str,
    agent_or_team: object,
) -> None:
    """Fire-and-forget background summary refresh.

    Only enqueues when summarization is enabled and the agent/team has
    a non-none memory_type. Safe to call even when summarization is
    off — short-circuits inside ``refresh_summary``.
    """
    if not settings.CONTEXT_MANAGER_SUMMARIZATION_ENABLED:
        return
    memory_type = getattr(agent_or_team, "_memory_type", "none")
    if memory_type == "none":
        return

    provider = getattr(agent_or_team, "_provider", None)
    memory_config_raw = getattr(agent_or_team, "_memory_config_raw", {}) or {}
    memory_config = MemoryConfig.from_dict(memory_config_raw, memory_type=memory_type, provider=provider)

    async def _task():
        try:
            history_records = await session_store.get_session_messages(
                owner_id, user_id, session_id,
            )
            performed = await context_manager.refresh_summary(
                owner_kind=owner_kind,
                owner_id=owner_id,
                user_id=user_id,
                session_id=session_id,
                history_records=history_records,
                provider=provider,
                memory_config=memory_config,
            )
            if performed:
                activity(
                    logger,
                    "context_manager_summary_refreshed",
                    entity_id=owner_id,
                    session_id=session_id,
                )
        except Exception:
            logger.exception(
                "Background summary refresh task failed for owner=%s session=%s",
                owner_id, session_id,
            )

    asyncio.create_task(_task())


def _emit_heuristic_calibration(
    cm_result: "_ContextPrepareResult",
    usage: dict | None,
    *,
    owner_kind: str,
    owner_id: str,
    session_id: str,
    provider: str | None,
    model: str | None,
) -> None:
    """Best-effort calibration metric. Compares the heuristic input-token
    estimate against the LLM's reported actual ``input_tokens`` and logs
    the relative error. Used to tune RATIOS / CONTENT_MULTIPLIERS in
    :mod:`token_counter` and to decide when to flip
    ``CONTEXT_MANAGER_USE_REAL_TOKENIZERS=true``.

    Safe to call without usage data — silently no-ops.
    """
    if not usage:
        return
    actual = usage.get("input_tokens") or usage.get("inputTokens") or usage.get("prompt_tokens")
    if not actual or not isinstance(actual, (int, float)) or actual <= 0:
        return
    estimated = cm_result.prepared.est_input_tokens
    if not estimated:
        return
    error_pct = (estimated - actual) / actual * 100.0
    activity(
        logger,
        "context_manager_heuristic_calibration",
        entity_id=owner_id,
        session_id=session_id,
        owner_kind=owner_kind,
        provider=provider,
        model=model,
        strategy=cm_result.prepared.strategy_used,
        estimated_input_tokens=estimated,
        actual_input_tokens=int(actual),
        error_pct=round(error_pct, 2),
    )




# --- Async task finalization ---


async def _finalize_async_task(
    task_id: str,
    agent_id: str,
    user_id: str,
    session_id: str,
    agent: object,
    run_response: object,
    user_message: str,
    response_text: str,
    latency_ms: int,
) -> None:
    """Run post-arun steps using a fresh Redis connection.

    MCP tool cleanup during arun() can corrupt the shared Redis connection
    pool (streamable-http disconnects interfere with asyncio transport state).
    Using a dedicated short-lived Redis client avoids this entirely.

    Task completion is done FIRST so the client gets its response even if
    session persistence fails.
    """
    logger.info("Async task %s: post-arun step 1/5 -- deduplicate_citations", task_id)
    from .kb_retrieval import deduplicate_citations
    raw_citations = getattr(agent, "_kb_citations", [])
    citations_data = deduplicate_citations(raw_citations) if raw_citations else None
    model_name = getattr(agent, "_model_name", None)
    usage_data = _extract_usage(run_response)

    logger.info("Async task %s: post-arun step 2/5 -- fresh_redis_connect", task_id)
    fresh_redis = create_async_redis_client(settings)
    fresh_task_mgr = TaskManager(
        fresh_redis,
        result_ttl=task_manager._result_ttl,
        running_ttl=task_manager._running_ttl,
    )
    fresh_session_store = SessionStore(
        fresh_redis,
        session_ttl=session_store._session_ttl,
        max_messages=session_store._max_messages,
    )

    try:
        await fresh_redis.ping()
        logger.info("Async task %s: fresh Redis connection OK", task_id)

        logger.info("Async task %s: post-arun step 3/5 -- complete_task", task_id)
        task_result: dict = {
            "response": response_text,
            "sessionId": session_id,
            "latencyMs": latency_ms,
            "modelName": model_name,
            "citations": citations_data,
            "usage": usage_data,
        }
        if getattr(agent, "_has_outcome_schema", False):
            task_result["parsedOutput"] = _extract_structured_output(response_text)
        await fresh_task_mgr.complete_task(task_id, task_result)
        logger.info(
            "Async task %s: task marked completed, now persisting session", task_id,
        )

        logger.info("Async task %s: post-arun step 4/5 -- save_user_message", task_id)
        await fresh_session_store.append_message(
            agent_id, user_id, session_id, "user", user_message,
        )

        logger.info("Async task %s: post-arun step 5/5 -- save_assistant_message", task_id)
        await fresh_session_store.append_message(
            agent_id, user_id, session_id, "assistant", response_text,
            metadata={
                "latencyMs": latency_ms,
                "modelName": model_name,
                "citations": citations_data,
                "usage": usage_data,
            },
        )
        logger.info("Async task %s: post-arun finalization done", task_id)
    finally:
        await fresh_redis.aclose()
        logger.info("Async task %s: fresh Redis connection closed", task_id)


def _friendly_error(raw: str) -> str:
    """Convert raw LLM/agent error messages to user-friendly text."""
    lower = raw.lower()
    if "contextwindowexceedederror" in lower or "context length" in lower:
        import re
        m = re.search(r"maximum context length is (\d[\d,]*) tokens.*?resulted in (\d[\d,]*) tokens", raw)
        if m:
            limit, used = m.group(1), m.group(2)
            return (
                f"The conversation exceeded the model's context window "
                f"({used} tokens used, {limit} max). "
                f"Please start a new session or shorten your request."
            )
        return (
            "The conversation exceeded the model's context window. "
            "Please start a new session or shorten your request."
        )
    if "rate_limit" in lower or "ratelimit" in lower or "429" in lower:
        return "The model is currently rate-limited. Please wait a moment and try again."
    if "authentication" in lower or "unauthorized" in lower or "401" in lower:
        return "Authentication error with the model provider. Please contact your administrator."
    if "timeout" in lower:
        return "The request timed out. Please try again with a simpler query."
    if len(raw) > 300:
        return raw[:300].rsplit(" ", 1)[0] + "…"
    return raw


def _normalize_event(event_raw: object) -> str:
    """Normalize an agno RunEvent enum or string to a canonical PascalCase name.

    Agno v2.5+ uses a RunEvent enum (e.g. RunEvent.tool_call_started) whose
    .value is "ToolCallStarted".  Older versions used plain strings.
    We normalize both to the PascalCase value so downstream comparisons work.
    """
    if event_raw is None:
        return ""
    if hasattr(event_raw, "value"):
        return str(event_raw.value)
    return str(event_raw)


def _extract_tool_result(tool_exec: object | None, content: str | None) -> object:
    """Extract the best structured result from an agno ToolCallCompleted chunk.

    Agno's streaming `content` for tool completions is typically a string
    representation.  The actual structured result may live on the tool
    execution object, or the content may be a JSON string that we can parse.
    We try multiple sources in priority order so the frontend receives a
    proper object (e.g. {columns, rows, rowCount}) rather than a flat string.
    """
    if tool_exec is not None:
        structured = getattr(tool_exec, "result", None)
        if structured is not None and not isinstance(structured, str):
            return structured

        tool_result_content = getattr(tool_exec, "tool_result_content", None)
        if tool_result_content is not None and not isinstance(tool_result_content, str):
            return tool_result_content

    raw = content
    if tool_exec is not None:
        str_result = getattr(tool_exec, "result", None)
        if isinstance(str_result, str) and str_result:
            raw = str_result

    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            pass

    return raw


def _extract_member_info(chunk: object, tool_exec: object | None = None) -> tuple[str | None, str | None]:
    """Best-effort extraction of member identity from team stream chunks."""
    candidates: list[object] = [tool_exec, chunk]
    for obj in candidates:
        if obj is None:
            continue
        member_name = (
            getattr(obj, "agent_name", None)
            or getattr(obj, "member_name", None)
            or getattr(obj, "from_agent", None)
            or getattr(obj, "from_member", None)
            or getattr(obj, "actor_name", None)
            or getattr(obj, "name", None)
        )
        member_id = (
            getattr(obj, "agent_id", None)
            or getattr(obj, "member_id", None)
            or getattr(obj, "from_agent_id", None)
            or getattr(obj, "from_member_id", None)
            or getattr(obj, "actor_id", None)
            or getattr(obj, "id", None)
        )
        if member_name or member_id:
            return (
                str(member_name) if member_name is not None else None,
                str(member_id) if member_id is not None else None,
            )

        nested_agent = getattr(obj, "agent", None) or getattr(obj, "member", None)
        if nested_agent is not None:
            nested_name = getattr(nested_agent, "name", None)
            nested_id = getattr(nested_agent, "id", None)
            if nested_name or nested_id:
                return (
                    str(nested_name) if nested_name is not None else None,
                    str(nested_id) if nested_id is not None else None,
                )
        # Last-resort: inspect object dict for likely identity keys.
        raw = getattr(obj, "__dict__", None)
        if isinstance(raw, dict):
            for nk in ("agent_name", "member_name", "from_agent", "from_member", "actor_name"):
                if isinstance(raw.get(nk), str) and raw.get(nk):
                    member_name = raw.get(nk)
                    break
            for ik in ("agent_id", "member_id", "from_agent_id", "from_member_id", "actor_id"):
                if isinstance(raw.get(ik), str) and raw.get(ik):
                    member_id = raw.get(ik)
                    break
            if member_name or member_id:
                return (
                    str(member_name) if member_name is not None else None,
                    str(member_id) if member_id is not None else None,
                )
    return None, None


def _extract_text_content(chunk: object, content: object | None) -> str:
    """Best-effort text extraction from team stream chunks."""
    if isinstance(content, str):
        return content
    if content is not None:
        if isinstance(content, dict):
            for key in ("text", "content", "message", "delta", "response"):
                value = content.get(key)
                if isinstance(value, str) and value:
                    return value
        if isinstance(content, list):
            parts = [str(p) for p in content if p]
            if parts:
                return "\n".join(parts)

    for attr in ("text", "delta", "message", "response", "content"):
        value = getattr(chunk, attr, None)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            for key in ("text", "content", "message", "delta", "response"):
                nested = value.get(key)
                if isinstance(nested, str) and nested:
                    return nested
    return ""


# ---------------------------------------------------------------------------
# Team stream helpers (type-safe event classification)
# ---------------------------------------------------------------------------

_DELEGATION_RE = re.compile(
    r'delegate_task_to_member\([^)]*\)\s*completed in\s+[0-9.]+s\.?',
    re.IGNORECASE,
)


def _safe_content_str(chunk: object) -> str:
    """Get content as a plain string from an event chunk.
    Returns empty string for non-string content to avoid leaking repr noise."""
    content = getattr(chunk, "content", None)
    return content if isinstance(content, str) else ""


def _strip_delegation_noise(text: str) -> str:
    """Remove Agno internal delegation debug lines from manager text."""
    return _DELEGATION_RE.sub("", text)


def _get_member_identity(chunk: object) -> tuple[str | None, str | None]:
    """Extract (agent_name, agent_id) from an Agno event chunk."""
    name = getattr(chunk, "agent_name", None) or getattr(chunk, "name", None)
    aid = getattr(chunk, "agent_id", None)
    if not name:
        tool = getattr(chunk, "tool", None)
        if tool:
            name = getattr(tool, "agent_name", None)
    return (str(name) if name else None, str(aid) if aid else None)


def _build_team_event_sets() -> tuple[set, set, set, set, set]:
    """Build event classification sets from Agno enums with version guards."""
    from agno.team import TeamRunEvent
    from agno.agent import RunEvent

    team_content = {TeamRunEvent.run_content}
    member_content = {RunEvent.run_content}
    tool_start = {TeamRunEvent.tool_call_started, RunEvent.tool_call_started}
    tool_done = {TeamRunEvent.tool_call_completed, RunEvent.tool_call_completed}
    errors = {TeamRunEvent.run_error, RunEvent.run_error,
              TeamRunEvent.run_cancelled, RunEvent.run_cancelled}

    for attr in ("run_response_content", "run_intermediate_content"):
        if hasattr(RunEvent, attr):
            member_content.add(getattr(RunEvent, attr))
        if hasattr(TeamRunEvent, attr):
            team_content.add(getattr(TeamRunEvent, attr))

    return team_content, member_content, tool_start, tool_done, errors


_team_event_sets: tuple[set, set, set, set, set] | None = None


def _get_team_event_sets() -> tuple[set, set, set, set, set]:
    """Lazily build and cache team event classification sets."""
    global _team_event_sets
    if _team_event_sets is None:
        _team_event_sets = _build_team_event_sets()
    return _team_event_sets


# --- Agent invocation endpoints ---


@app.post(
    "/api/v1/projects/{project_id}/agents/{agent_id}/invoke",
    response_model=InvokeResponse,
)
async def invoke_agent(
    project_id: str, agent_id: str, body: InvokeRequest, request: Request
):
    rid = activity_request_id(request)
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    jwt_token = request.headers.get("Authorization", "")
    agent_config = await config_cache.get(project_id, agent_id)
    validate_project_access(project_id, user_ctx, agent_config)
    agent_config = await _apply_model_override(body, agent_config, project_id)

    session_id = body.sessionId or str(uuid.uuid4())
    kb_ids = agent_config.get("knowledgeBaseIds", [])

    activity(
        logger,
        "invoke_agent",
        request_id=rid,
        project_id=project_id,
        agent_id=agent_id,
        user_id=user_id,
        session_id=session_id,
        mode="sync",
        has_model_override=bool(body.modelId),
        attachments=len(body.attachments or []),
        message_chars=len(body.message),
    )
    logger.info(
        "Invoking agent %s (model=%s, kbs=%d, mcp_servers=%d) session=%s user=%s",
        agent_id,
        agent_config.get("modelAlias") or agent_config.get("modelId"),
        len(kb_ids),
        len(agent_config.get("mcpServerIds", [])),
        session_id,
        user_id,
    )

    try:
        agent = await agent_factory.create_from_config(
            agent_config,
            user_label=user_ctx.get("user_email") or user_id,
        )
    except Exception as exc:
        logger.exception(
            "Agent creation FAILED for agent %s: %s: %s",
            agent_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=422,
            detail=f"Failed to create agent: {type(exc).__name__}: {exc}",
        )

    arun_input, cm_result = await _build_arun_input(
        agent, body.message, "agent", agent_id, user_id, session_id,
    )
    logger.info(
        "Sync invoke agent %s: context_manager prepared strategy=%s "
        "est_tokens=%d ctx_window=%d (%s) trimmed_turns=%d session=%s",
        agent_id,
        cm_result.prepared.strategy_used,
        cm_result.prepared.est_input_tokens,
        cm_result.prepared.context_window,
        cm_result.prepared.context_window_source,
        cm_result.prepared.trimmed_turn_count,
        session_id,
    )

    loaded_mcp_ids: list[str] = getattr(agent, "_loaded_mcp_server_ids", [])
    agent_timeout = getattr(agent, "_timeout_seconds", 300)
    try:
        with phoenix_project_scope(project_id):
            t0 = time.monotonic()
            logger.info(
                "Sync invoke agent %s: calling agent.arun() session=%s mcp_servers=%s timeout=%ds",
                agent_id, session_id, loaded_mcp_ids, agent_timeout,
            )
            async with _invoke_semaphore:
                try:
                    run_response = await asyncio.wait_for(
                        agent.arun(
                            arun_input,
                            session_id=session_id,
                            user_id=user_id,
                            metadata={"project_id": project_id, "authorization": jwt_token},
                        ),
                        timeout=agent_timeout,
                    )
                except Exception as exc:
                    retry_input = (
                        _retry_input_for_overflow(cm_result)
                        if is_context_overflow_error(exc) else None
                    )
                    if retry_input is None:
                        raise
                    logger.warning(
                        "Sync invoke agent %s: context overflow despite proactive sizing; "
                        "retrying with aggressive trim",
                        agent_id,
                    )
                    activity(
                        logger,
                        "context_overflow_reactive_retry",
                        entity_id=agent_id,
                        session_id=session_id,
                        outcome="attempted",
                    )
                    run_response = await asyncio.wait_for(
                        agent.arun(
                            retry_input,
                            session_id=session_id,
                            user_id=user_id,
                            metadata={"project_id": project_id, "authorization": jwt_token},
                        ),
                        timeout=agent_timeout,
                    )
        latency_ms = int((time.monotonic() - t0) * 1000)
        response_text = run_response.content if hasattr(run_response, "content") else str(run_response)
        logger.info(
            "Sync invoke agent %s: arun completed in %.3fs response_len=%d "
            "response_type=%s session=%s",
            agent_id, latency_ms / 1000, len(response_text),
            type(run_response).__name__, session_id,
        )
        activity(
            logger,
            "invoke_agent_done",
            request_id=rid,
            project_id=project_id,
            agent_id=agent_id,
            session_id=session_id,
            latency_ms=latency_ms,
            response_chars=len(response_text),
        )
        for sid in loaded_mcp_ids:
            mcp_pool.mark_healthy(sid)
    except Exception as exc:
        for sid in loaded_mcp_ids:
            mcp_pool.mark_unhealthy(sid, f"{type(exc).__name__}: {exc}")
        activity(
            logger,
            "invoke_agent_failed",
            request_id=rid,
            project_id=project_id,
            agent_id=agent_id,
            session_id=session_id,
            error_type=type(exc).__name__,
        )
        logger.error(
            "Sync invocation FAILED for agent %s: error_type=%s error=%s "
            "model=%s modelAlias=%s session=%s config_keys=[%s]",
            agent_id,
            type(exc).__name__,
            str(exc),
            agent_config.get("modelId"),
            agent_config.get("modelAlias"),
            session_id,
            ", ".join(sorted(agent_config.keys())),
        )
        logger.exception("Full traceback for agent %s invocation failure:", agent_id)
        raise

    from .kb_retrieval import deduplicate_citations
    raw_citations = getattr(agent, "_kb_citations", [])
    citations = [CitationItem(**c) for c in deduplicate_citations(raw_citations)] if raw_citations else None
    model_name = getattr(agent, "_model_name", None)
    usage = _extract_usage(run_response)

    _emit_heuristic_calibration(
        cm_result, usage,
        owner_kind="agent", owner_id=agent_id, session_id=session_id,
        provider=getattr(agent, "_provider", None), model=model_name,
    )

    _maybe_enqueue_summary_refresh(
        cm_result,
        owner_kind="agent",
        owner_id=agent_id,
        user_id=user_id,
        session_id=session_id,
        agent_or_team=agent,
    )

    await session_store.append_message(agent_id, user_id, session_id, "user", body.message)
    await session_store.append_message(
        agent_id, user_id, session_id, "assistant", response_text,
        metadata={
            "latencyMs": latency_ms,
            "modelName": model_name,
            "citations": [c.model_dump(exclude_none=True) for c in citations] if citations else None,
            "usage": usage,
        },
    )

    return InvokeResponse(
        response=response_text,
        sessionId=session_id,
        latencyMs=latency_ms,
        modelName=model_name,
        citations=citations,
        usage=UsageItem(**usage) if usage else None,
    )


async def _persist_stream_session(
    agent_id: str, user_id: str, session_id: str,
    user_message: str, assistant_response: str,
    latency_ms: int, model_name: str | None,
    usage: dict | None,
    citations: list | None,
    tool_calls: list[dict] | None = None,
    trace_id: str | None = None,
) -> None:
    """Persist stream session messages in the background.

    Runs as a fire-and-forget task so the SSE response can close cleanly
    without waiting for Redis I/O.
    """
    try:
        await session_store.append_message(
            agent_id, user_id, session_id, "user", user_message
        )
        metadata: dict = {
            "latencyMs": latency_ms,
            "modelName": model_name,
            "usage": usage,
            "citations": citations,
        }
        if tool_calls:
            metadata["toolCalls"] = tool_calls
        if trace_id:
            metadata["traceId"] = trace_id
        await session_store.append_message(
            agent_id, user_id, session_id, "assistant", assistant_response,
            metadata=metadata,
        )
        logger.info(
            "Stream session persisted: agent=%s session=%s chars=%d tool_calls=%d trace=%s",
            agent_id, session_id, len(assistant_response), len(tool_calls or []),
            trace_id or "-",
        )
    except Exception:
        logger.exception(
            "Failed to persist stream session: agent=%s session=%s",
            agent_id, session_id,
        )


@app.post(
    "/api/v1/projects/{project_id}/agents/{agent_id}/invoke/stream",
)
async def invoke_agent_stream(
    project_id: str, agent_id: str, body: InvokeRequest, request: Request
):
    rid = activity_request_id(request)
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    jwt_token = request.headers.get("Authorization", "")
    _validate_attachments(body.attachments)
    agent_config = await config_cache.get(project_id, agent_id)
    validate_project_access(project_id, user_ctx, agent_config)
    agent_config = await _apply_model_override(body, agent_config, project_id)

    session_id = body.sessionId or str(uuid.uuid4())
    kb_ids = agent_config.get("knowledgeBaseIds", [])
    activity(
        logger,
        "invoke_agent_stream_start",
        request_id=rid,
        project_id=project_id,
        agent_id=agent_id,
        user_id=user_id,
        session_id=session_id,
        has_model_override=bool(body.modelId),
        attachments=len(body.attachments or []),
        message_chars=len(body.message),
    )
    logger.info(
        "Stream invoking agent %s (model=%s, kbs=%d, mcp_servers=%d) session=%s user=%s",
        agent_id,
        agent_config.get("modelAlias") or agent_config.get("modelId"),
        len(kb_ids),
        len(agent_config.get("mcpServerIds", [])),
        session_id,
        user_id,
    )
    try:
        agent = await agent_factory.create_from_config(
            agent_config,
            user_label=user_ctx.get("user_email") or user_id,
        )
    except Exception as exc:
        logger.exception(
            "Agent creation FAILED for agent %s (stream): %s: %s",
            agent_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=422,
            detail=f"Failed to create agent: {type(exc).__name__}: {exc}",
        )
    user_message = _prepend_attachment_context(body.message, body.attachments)
    arun_input, cm_result = await _build_arun_input(
        agent, user_message, "agent", agent_id, user_id, session_id,
    )
    logger.info(
        "Stream invoke agent %s: context_manager prepared strategy=%s "
        "est_tokens=%d ctx_window=%d (%s) trimmed_turns=%d session=%s",
        agent_id,
        cm_result.prepared.strategy_used,
        cm_result.prepared.est_input_tokens,
        cm_result.prepared.context_window,
        cm_result.prepared.context_window_source,
        cm_result.prepared.trimmed_turn_count,
        session_id,
    )

    loaded_mcp_ids: list[str] = getattr(agent, "_loaded_mcp_server_ids", [])

    async def event_generator() -> AsyncGenerator:
        _phoenix_proj_tok = agentstudio_phoenix_project_id.set(project_id)
        try:
            full_response = ""
            chunk_count = 0
            arun_ok = False
            completed_tool_calls: list[dict] = []
            pending_tool_calls: dict[str, dict] = {}
            t0 = time.monotonic()
            usage_data: dict | None = None
            trace_id: str | None = None
            latency_ms = 0
            model_name: str | None = None
            citations_data = None
            try:
                logger.info(
                    "Stream started for agent %s, session %s mcp_servers=%s",
                    agent_id, session_id, loaded_mcp_ids,
                )
                _span_cm = (
                    _tracer.start_as_current_span(
                        f"invoke_agent_{agent_id}",
                        attributes={
                            "session.id": session_id,
                            "project.id": project_id,
                            "agent.id": agent_id,
                        },
                    )
                    if tracing_enabled()
                    else contextlib.nullcontext()
                )
                with _span_cm as _otel_span:
                    if _otel_span is not None:
                        _sc = _otel_span.get_span_context()
                        if _sc.trace_id != 0:
                            trace_id = format(_sc.trace_id, "032x")
                    async with _invoke_semaphore:
                        # Pre-first-SSE-chunk reactive retry: if the LLM
                        # rejects the request with a context overflow
                        # before we yield any chunk to the SSE client,
                        # restart with an aggressively-trimmed input.
                        # Once any SSE chunk has been yielded the stream
                        # contract prevents transparent retry.
                        current_arun_input: object = arun_input
                        retry_attempted_stream = False
                        sse_chunks_yielded = 0
                        while True:
                            try:
                                async for chunk in agent.arun(
                                    current_arun_input,
                                    session_id=session_id,
                                    user_id=user_id,
                                    metadata={"project_id": project_id, "authorization": jwt_token},
                                    stream=True,
                                    stream_events=True,
                                ):
                                    chunk_count += 1
                                    event_raw = getattr(chunk, "event", None)
                                    content = getattr(chunk, "content", None)
                                    event_name = _normalize_event(event_raw)
                                    usage_data = _extract_usage(chunk) or usage_data
                                    logger.debug(
                                        "Stream chunk #%d: event_raw=%r event_name=%s content_len=%s type=%s",
                                        chunk_count,
                                        event_raw,
                                        event_name,
                                        len(content) if content else 0,
                                        type(event_raw).__name__,
                                    )
                                    if event_name == "ToolCallStarted":
                                        tool_exec = getattr(chunk, "tool", None)
                                        if tool_exec:
                                            tc_id = getattr(tool_exec, "tool_call_id", None) or str(uuid.uuid4())
                                            tc_name = getattr(tool_exec, "tool_name", "") or ""
                                            tc_args = getattr(tool_exec, "tool_args", {}) or {}
                                            pending_tool_calls[tc_id] = {
                                                "toolCallId": tc_id,
                                                "toolName": tc_name,
                                                "args": tc_args,
                                            }
                                            logger.info(
                                                "ToolCallStarted: tool=%s call_id=%s args_keys=%s",
                                                tc_name, tc_id, list(tc_args.keys()) if isinstance(tc_args, dict) else "?",
                                            )
                                            sse_chunks_yielded += 1
                                            yield {
                                                "event": "tool_call_start",
                                                "data": json.dumps({
                                                    "toolCallId": tc_id,
                                                    "toolName": tc_name,
                                                    "args": tc_args,
                                                }, default=str),
                                            }
                                    elif event_name == "ToolCallCompleted":
                                        tool_exec = getattr(chunk, "tool", None)
                                        tool_result = _extract_tool_result(tool_exec, content)
                                        tool_call_id = getattr(tool_exec, "tool_call_id", "") if tool_exec else ""
                                        tool_name = getattr(tool_exec, "tool_name", "") if tool_exec else ""
                                        tc_entry = pending_tool_calls.pop(tool_call_id, {
                                            "toolCallId": tool_call_id,
                                            "toolName": tool_name,
                                            "args": {},
                                        })
                                        tc_entry["result"] = tool_result
                                        completed_tool_calls.append(tc_entry)
                                        logger.info(
                                            "ToolCallCompleted: tool=%s call_id=%s result_type=%s result_preview=%.200s",
                                            tool_name, tool_call_id, type(tool_result).__name__,
                                            str(tool_result)[:200],
                                        )
                                        sse_chunks_yielded += 1
                                        yield {
                                            "event": "tool_call_result",
                                            "data": json.dumps({
                                                "toolCallId": tool_call_id,
                                                "result": tool_result,
                                            }, default=str),
                                        }
                                    elif event_name in ("RunContent", "RunResponseContent"):
                                        if content:
                                            full_response += content
                                            sse_chunks_yielded += 1
                                            yield {"event": "message", "data": content}
                                    elif event_name in ("RunError", "RunCancelled"):
                                        friendly = _friendly_error(content or "An unknown error occurred")
                                        logger.error(
                                            "Agent run error event: event=%s friendly=%s raw=%.300s",
                                            event_name, friendly, content,
                                        )
                                        sse_chunks_yielded += 1
                                        yield {"event": "error", "data": friendly}
                                    else:
                                        logger.debug(
                                            "Stream chunk #%d: ignoring event=%s (content_len=%s)",
                                            chunk_count, event_name,
                                            len(content) if content else 0,
                                        )
                                break  # arun yielded its iterator cleanly
                            except Exception as stream_exc:
                                if (
                                    not retry_attempted_stream
                                    and sse_chunks_yielded == 0
                                    and is_context_overflow_error(stream_exc)
                                ):
                                    retry_input = _retry_input_for_overflow(cm_result)
                                    if retry_input is not None:
                                        retry_attempted_stream = True
                                        logger.warning(
                                            "Stream invoke agent %s: pre-first-chunk context overflow; "
                                            "retrying with aggressive trim",
                                            agent_id,
                                        )
                                        activity(
                                            logger,
                                            "context_overflow_reactive_retry",
                                            entity_id=agent_id,
                                            session_id=session_id,
                                            outcome="stream_pre_chunk_retry",
                                        )
                                        current_arun_input = retry_input
                                        # reset chunk_count? leave as-is so we
                                        # see total chunks across retries.
                                        continue
                                raise
                    arun_ok = True
                    logger.info(
                        "Stream completed for agent %s: %d chunks, %d chars",
                        agent_id, chunk_count, len(full_response),
                    )
                    for sid in loaded_mcp_ids:
                        mcp_pool.mark_healthy(sid)

                    from .kb_retrieval import deduplicate_citations
                    raw_citations = getattr(agent, "_kb_citations", [])
                    citations_data = deduplicate_citations(raw_citations) if raw_citations else None
                    latency_ms = int((time.monotonic() - t0) * 1000)
                    model_name = getattr(agent, "_model_name", None)

                    done_payload: dict = {
                        "sessionId": session_id,
                        "latencyMs": latency_ms,
                        "modelName": model_name,
                        "usage": usage_data,
                        "citations": citations_data,
                    }
                    if trace_id:
                        done_payload["traceId"] = trace_id
                    yield {
                        "event": "done",
                        "data": json.dumps(done_payload),
                    }
            except Exception as e:
                if not arun_ok:
                    for sid in loaded_mcp_ids:
                        mcp_pool.mark_unhealthy(sid, f"{type(e).__name__}: {e}")
                logger.exception(
                    "Stream invocation failed for agent %s (model=%s, session=%s)",
                    agent_id,
                    agent_config.get("modelAlias") or agent_config.get("modelId"),
                    session_id,
                )
                yield {"event": "error", "data": _friendly_error(str(e))}
            finally:
                if full_response:
                    final_latency = int((time.monotonic() - t0) * 1000) if not arun_ok else latency_ms
                    final_model = getattr(agent, "_model_name", None) if not arun_ok else model_name
                    final_citations = None
                    if not arun_ok:
                        from .kb_retrieval import deduplicate_citations
                        raw = getattr(agent, "_kb_citations", [])
                        final_citations = deduplicate_citations(raw) if raw else None
                    else:
                        final_citations = citations_data

                    asyncio.create_task(_persist_stream_session(
                        agent_id, user_id, session_id,
                        body.message, full_response,
                        final_latency, final_model, usage_data, final_citations,
                        completed_tool_calls,
                        trace_id=trace_id,
                    ))
        finally:
            agentstudio_phoenix_project_id.reset(_phoenix_proj_tok)

    return EventSourceResponse(event_generator(), ping=15)


@app.post(
    "/api/v1/projects/{project_id}/agents/{agent_id}/invoke/async",
    response_model=AsyncInvokeResponse,
)
async def invoke_agent_async(
    project_id: str, agent_id: str, body: InvokeRequest, request: Request
):
    rid = activity_request_id(request)
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    jwt_token = request.headers.get("Authorization", "")
    agent_config = await config_cache.get(project_id, agent_id)
    validate_project_access(project_id, user_ctx, agent_config)
    agent_config = await _apply_model_override(body, agent_config, project_id)

    task_id = await task_manager.create_task(project_id, agent_id)
    activity(
        logger,
        "invoke_agent_async_queued",
        request_id=rid,
        project_id=project_id,
        agent_id=agent_id,
        task_id=task_id,
        user_id=user_id,
        has_model_override=bool(body.modelId),
    )

    kb_ids = agent_config.get("knowledgeBaseIds", [])

    _POST_ARUN_TIMEOUT = 30

    async def _run_async():
        with phoenix_project_scope(project_id):
            session_id = body.sessionId or str(uuid.uuid4())
            step = "init"
            try:
                step = "config_log"
                logger.info(
                    "Async task %s: invoking agent %s (model=%s, kbs=%d, mcp_servers=%d) session=%s user=%s",
                    task_id, agent_id,
                    agent_config.get("modelAlias") or agent_config.get("modelId"),
                    len(kb_ids),
                    len(agent_config.get("mcpServerIds", [])),
                    session_id,
                    user_id,
                )
                step = "create_agent"
                agent = await agent_factory.create_from_config(
                    agent_config,
                    user_label=user_ctx.get("user_email") or user_id,
                )
                step = "build_history"
                arun_input, cm_result = await _build_arun_input(
                    agent, body.message, "agent", agent_id, user_id, session_id,
                )
                logger.info(
                    "Async task %s: context_manager prepared strategy=%s "
                    "est_tokens=%d ctx_window=%d (%s) trimmed_turns=%d session=%s",
                    task_id,
                    cm_result.prepared.strategy_used,
                    cm_result.prepared.est_input_tokens,
                    cm_result.prepared.context_window,
                    cm_result.prepared.context_window_source,
                    cm_result.prepared.trimmed_turn_count,
                    session_id,
                )
                loaded_mcp_ids = getattr(agent, "_loaded_mcp_server_ids", [])

                step = "arun"
                t0 = time.monotonic()
                agent_timeout = getattr(agent, "_timeout_seconds", 300)
                try:
                    async with _invoke_semaphore:
                        try:
                            run_response = await asyncio.wait_for(
                                agent.arun(
                                    arun_input,
                                    session_id=session_id,
                                    user_id=user_id,
                                    metadata={"project_id": project_id, "authorization": jwt_token},
                                ),
                                timeout=agent_timeout,
                            )
                        except Exception as exc:
                            retry_input = (
                                _retry_input_for_overflow(cm_result)
                                if is_context_overflow_error(exc) else None
                            )
                            if retry_input is None:
                                raise
                            logger.warning(
                                "Async task %s: context overflow despite proactive sizing; "
                                "retrying with aggressive trim",
                                task_id,
                            )
                            activity(
                                logger,
                                "context_overflow_reactive_retry",
                                entity_id=agent_id,
                                session_id=session_id,
                                outcome="async_retry",
                            )
                            run_response = await asyncio.wait_for(
                                agent.arun(
                                    retry_input,
                                    session_id=session_id,
                                    user_id=user_id,
                                    metadata={"project_id": project_id, "authorization": jwt_token},
                                ),
                                timeout=agent_timeout,
                            )
                    for sid in loaded_mcp_ids:
                        mcp_pool.mark_healthy(sid)
                except asyncio.TimeoutError:
                    for sid in loaded_mcp_ids:
                        mcp_pool.mark_unhealthy(
                            sid, f"arun timed out for task {task_id}",
                        )
                    raise asyncio.TimeoutError(
                        f"Agent exceeded guardrail timeout of {agent_timeout}s"
                    )
                except Exception:
                    for sid in loaded_mcp_ids:
                        mcp_pool.mark_unhealthy(
                            sid, f"arun failed for task {task_id}",
                        )
                    raise
                latency_ms = int((time.monotonic() - t0) * 1000)

                step = "extract_response"
                response_text = (
                    run_response.content
                    if hasattr(run_response, "content")
                    else str(run_response)
                )
                logger.info(
                    "Async task %s: arun completed in %.3fs response_len=%d "
                    "response_preview=%.100s",
                    task_id, latency_ms / 1000, len(response_text),
                    response_text[:200],
                )

                step = "finalize"
                await asyncio.wait_for(
                    _finalize_async_task(
                        task_id, agent_id, user_id, session_id,
                        agent, run_response, body.message, response_text, latency_ms,
                    ),
                    timeout=_POST_ARUN_TIMEOUT,
                )
                step = "done"
                logger.info(
                    "Async task %s: fully completed (agent=%s, session=%s, latency=%dms)",
                    task_id, agent_id, session_id, latency_ms,
                )
            except asyncio.TimeoutError:
                logger.error(
                    "Async task %s TIMED OUT at step='%s' after %ds "
                    "(post-arun finalization hung -- likely Redis stall). "
                    "Marking task as failed. agent=%s session=%s",
                    task_id, step, _POST_ARUN_TIMEOUT, agent_id, session_id,
                )
                try:
                    await task_manager.fail_task(
                        task_id,
                        f"[{step}] Post-arun finalization timed out after {_POST_ARUN_TIMEOUT}s",
                    )
                except Exception as fail_exc:
                    logger.error(
                        "Async task %s: fail_task() after timeout also raised: %s",
                        task_id, fail_exc,
                    )
            except Exception as e:
                logger.exception(
                    "Async task %s FAILED at step='%s' for agent %s (model=%s): %s",
                    task_id, step, agent_id,
                    agent_config.get("modelAlias") or agent_config.get("modelId"),
                    e,
                )
                try:
                    await task_manager.fail_task(task_id, f"[{step}] {e}")
                except Exception as fail_exc:
                    logger.error(
                        "Async task %s: fail_task() itself raised: %s "
                        "(task is now orphaned in 'running' state)",
                        task_id, fail_exc,
                    )

    asyncio.create_task(_run_async())
    return AsyncInvokeResponse(taskId=task_id)


@app.get(
    "/api/v1/projects/{project_id}/tasks/{task_id}",
    response_model=TaskStatusResponse,
)
async def get_task_status(project_id: str, task_id: str, request: Request):
    get_user_context(request)
    task = await task_manager.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    status = task["status"]
    has_result = task.get("result") is not None
    has_error = task.get("error") is not None
    logger.debug(
        "Task poll %s: status=%s has_result=%s has_error=%s",
        task_id, status, has_result, has_error,
    )
    if status != "running":
        logger.info(
            "Task %s terminal status returned: status=%s has_result=%s error=%s",
            task_id, status, has_result, task.get("error"),
        )
    return TaskStatusResponse(
        status=status,
        result=task.get("result"),
        error=task.get("error"),
    )


# --- Session endpoints ---


class RenameSessionRequest(BaseModel):
    name: str


@app.get("/api/v1/projects/{project_id}/traces/{trace_id}/spans")
async def get_trace_spans(project_id: str, trace_id: str, request: Request):
    """Proxy to Phoenix REST API: list spans for an OpenTelemetry trace_id."""
    user_ctx = get_user_context(request)
    if project_id != user_ctx["project_id"]:
        raise HTTPException(status_code=403, detail="Project access denied")
    phoenix_url = get_phoenix_api_url()
    if not phoenix_url:
        raise HTTPException(status_code=404, detail="Tracing is not configured")
    # Phoenix project name == AgentStudio project id (same as OTLP PROJECT_NAME per invoke).
    safe_project = quote(project_id, safe="")
    url = f"{phoenix_url}/v1/projects/{safe_project}/spans"
    params = {"trace_id": trace_id, "limit": 1000}
    headers: dict[str, str] = {}
    if settings.PHOENIX_API_KEY:
        headers["Authorization"] = f"Bearer {settings.PHOENIX_API_KEY}"
    try:
        resp = await kb_http_client.get(
            url,
            params=params,
            headers=headers,
            timeout=settings.PHOENIX_PROXY_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Phoenix trace query timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Phoenix returned {e.response.status_code}",
        )
    except Exception as e:
        logger.warning("Phoenix proxy error: %s", e)
        raise HTTPException(status_code=502, detail="Failed to reach tracing backend")


@app.get("/api/v1/projects/{project_id}/agents/{agent_id}/sessions")
async def list_sessions(project_id: str, agent_id: str, request: Request):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    sessions = await session_store.list_sessions(agent_id, user_id)
    return {"sessions": sessions}


@app.get(
    "/api/v1/projects/{project_id}/agents/{agent_id}/sessions/{session_id}"
)
async def get_session(
    project_id: str, agent_id: str, session_id: str, request: Request
):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    messages = await session_store.get_session_messages(agent_id, user_id, session_id)
    meta = await session_store.get_session_meta(agent_id, user_id, session_id)
    return {"sessionId": session_id, "messages": messages, **meta}


@app.patch(
    "/api/v1/projects/{project_id}/agents/{agent_id}/sessions/{session_id}"
)
async def rename_session(
    project_id: str,
    agent_id: str,
    session_id: str,
    body: RenameSessionRequest,
    request: Request,
):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    await session_store.rename_session(agent_id, user_id, session_id, body.name)
    activity(
        logger,
        "session_rename",
        request_id=activity_request_id(request),
        project_id=project_id,
        entity="agent",
        agent_id=agent_id,
        session_id=session_id,
        name_len=len(body.name or ""),
    )
    return {"sessionId": session_id, "name": body.name}


@app.delete(
    "/api/v1/projects/{project_id}/agents/{agent_id}/sessions/{session_id}"
)
async def delete_session(
    project_id: str, agent_id: str, session_id: str, request: Request
):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    await session_store.delete_session(agent_id, user_id, session_id)
    activity(
        logger,
        "session_delete",
        request_id=activity_request_id(request),
        project_id=project_id,
        entity="agent",
        agent_id=agent_id,
        session_id=session_id,
    )
    return {"deleted": True}


# --- Agent Team invocation endpoints ---


async def _fetch_team_config(project_id: str, team_id: str) -> dict:
    """Fetch agent team config from config-service with cache."""
    return await config_cache.get_team(project_id, team_id)


@app.post(
    "/api/v1/projects/{project_id}/agent-teams/{team_id}/invoke",
    response_model=InvokeResponse,
)
async def invoke_team(
    project_id: str, team_id: str, body: InvokeRequest, request: Request
):
    rid = activity_request_id(request)
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    jwt_token = request.headers.get("Authorization", "")
    team_config = await _fetch_team_config(project_id, team_id)
    validate_project_access(project_id, user_ctx, team_config)
    team_config = await _apply_team_model_override(body, team_config, project_id)

    session_id = body.sessionId or str(uuid.uuid4())
    activity(
        logger,
        "invoke_team",
        request_id=rid,
        project_id=project_id,
        team_id=team_id,
        user_id=user_id,
        session_id=session_id,
        mode="sync",
        has_model_override=bool(body.modelId),
        message_chars=len(body.message),
    )
    try:
        team = await team_factory.create_from_config(
            team_config,
            project_id,
            user_label=user_ctx.get("user_email") or user_id,
        )
    except Exception as exc:
        logger.exception(
            "Team creation FAILED for team %s: %s: %s",
            team_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=422,
            detail=f"Failed to create team: {type(exc).__name__}: {exc}",
        )
    manager_model = getattr(team, "_model_name", None)
    arun_input, cm_result = await _build_arun_input(
        team, body.message, "team", team_id, user_id, session_id,
    )
    t0 = time.monotonic()
    try:
        with phoenix_project_scope(project_id):
            _span_cm = (
                _tracer.start_as_current_span(
                    f"invoke_team_{team_id}",
                    attributes={
                        "session.id": session_id,
                        "project.id": project_id,
                        "team.id": team_id,
                    },
                )
                if tracing_enabled()
                else contextlib.nullcontext()
            )
            with _span_cm:
                with agno_team_nest_under_current_span():
                    async with _invoke_semaphore:
                        try:
                            run_response = await team.arun(
                                arun_input,
                                session_id=session_id,
                                user_id=user_id,
                                metadata={"project_id": project_id, "authorization": jwt_token},
                            )
                        except Exception as team_exc:
                            retry_input = (
                                _retry_input_for_overflow(cm_result)
                                if is_context_overflow_error(team_exc) else None
                            )
                            if retry_input is None:
                                raise
                            logger.warning(
                                "Team sync invoke %s: context overflow; retrying with aggressive trim",
                                team_id,
                            )
                            activity(
                                logger,
                                "context_overflow_reactive_retry",
                                entity_id=team_id,
                                session_id=session_id,
                                outcome="team_sync_retry",
                            )
                            run_response = await team.arun(
                                retry_input,
                                session_id=session_id,
                                user_id=user_id,
                                metadata={"project_id": project_id, "authorization": jwt_token},
                            )
            latency_ms = int((time.monotonic() - t0) * 1000)
            response_text = (
                run_response.content if hasattr(run_response, "content") else str(run_response)
            )
            usage = _extract_usage(run_response)
    except Exception as exc:
        activity(
            logger,
            "invoke_team_failed",
            request_id=rid,
            project_id=project_id,
            team_id=team_id,
            session_id=session_id,
            error_type=type(exc).__name__,
        )
        logger.exception(
            "Team sync invocation FAILED for team %s session=%s",
            team_id, session_id,
        )
        raise

    await session_store.append_message(team_id, user_id, session_id, "user", body.message)
    await session_store.append_message(
        team_id, user_id, session_id, "assistant", response_text,
        metadata={"latencyMs": latency_ms, "modelName": manager_model, "usage": usage},
    )

    activity(
        logger,
        "invoke_team_done",
        request_id=rid,
        project_id=project_id,
        team_id=team_id,
        session_id=session_id,
        latency_ms=latency_ms,
        response_chars=len(response_text),
    )

    return InvokeResponse(
        response=response_text,
        sessionId=session_id,
        latencyMs=latency_ms,
        modelName=manager_model,
        usage=UsageItem(**usage) if usage else None,
    )


@app.post(
    "/api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/stream",
)
async def invoke_team_stream(
    project_id: str, team_id: str, body: InvokeRequest, request: Request
):
    rid = activity_request_id(request)
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    jwt_token = request.headers.get("Authorization", "")
    _validate_attachments(body.attachments)
    team_config = await _fetch_team_config(project_id, team_id)
    validate_project_access(project_id, user_ctx, team_config)
    team_config = await _apply_team_model_override(body, team_config, project_id)
    session_id = body.sessionId or str(uuid.uuid4())
    activity(
        logger,
        "invoke_team_stream_start",
        request_id=rid,
        project_id=project_id,
        team_id=team_id,
        user_id=user_id,
        session_id=session_id,
        has_model_override=bool(body.modelId),
        attachments=len(body.attachments or []),
        message_chars=len(body.message),
    )
    try:
        team = await team_factory.create_from_config(
            team_config,
            project_id,
            user_label=user_ctx.get("user_email") or user_id,
        )
    except Exception as exc:
        logger.exception(
            "Team creation FAILED for team %s (stream): %s: %s",
            team_id, type(exc).__name__, exc,
        )
        raise HTTPException(
            status_code=422,
            detail=f"Failed to create team: {type(exc).__name__}: {exc}",
        )
    user_message = _prepend_attachment_context(body.message, body.attachments)
    arun_input, cm_result = await _build_arun_input(
        team, user_message, "team", team_id, user_id, session_id,
    )
    logger.info(
        "Team stream invoke %s: context_manager prepared strategy=%s "
        "est_tokens=%d ctx_window=%d (%s) trimmed_turns=%d session=%s",
        team_id,
        cm_result.prepared.strategy_used,
        cm_result.prepared.est_input_tokens,
        cm_result.prepared.context_window,
        cm_result.prepared.context_window_source,
        cm_result.prepared.trimmed_turn_count,
        session_id,
    )

    manager_model = getattr(team, "_model_name", None)

    async def event_generator():
        _phoenix_proj_tok = agentstudio_phoenix_project_id.set(project_id)
        try:
            t0 = time.monotonic()
            full_response = ""
            chunk_count = 0
            usage_data: dict | None = None
            completed_tool_calls: list[dict] = []
            pending_tool_calls: dict[str, dict] = {}
            pending_member_text: dict[str, dict[str, str | None]] = {}

            team_content, member_content, tool_start, tool_done, errors = (
                _get_team_event_sets()
            )

            def _member_key(member_name: str | None, member_id: str | None) -> str:
                return f"{member_id or ''}|{member_name or ''}"

            def _drain_member_buffers() -> list[dict[str, str]]:
                drained_events: list[dict[str, str]] = []
                for payload in list(pending_member_text.values()):
                    text_value = (payload.get("text") or "")
                    if not isinstance(text_value, str):
                        continue
                    text_chunk = text_value
                    if not text_chunk.strip():
                        continue
                    tc_id = str(uuid.uuid4())
                    completed_tool_calls.append({
                        "toolCallId": tc_id,
                        "toolName": "__member_response__",
                        "args": {},
                        "memberName": payload.get("memberName"),
                        "memberId": payload.get("memberId"),
                        "result": text_chunk,
                    })
                    drained_events.append({
                        "event": "tool_call_start",
                        "data": json.dumps({
                            "toolCallId": tc_id,
                            "toolName": "__member_response__",
                            "args": {},
                            "memberName": payload.get("memberName"),
                            "memberId": payload.get("memberId"),
                        }, default=str),
                    })
                    drained_events.append({
                        "event": "tool_call_result",
                        "data": json.dumps({
                            "toolCallId": tc_id,
                            "result": text_chunk,
                            "memberName": payload.get("memberName"),
                            "memberId": payload.get("memberId"),
                        }, default=str),
                    })
                pending_member_text.clear()
                return drained_events

            trace_id: str | None = None
            latency_ms = 0
            try:
                _span_cm = (
                    _tracer.start_as_current_span(
                        f"invoke_team_{team_id}",
                        attributes={
                            "session.id": session_id,
                            "project.id": project_id,
                            "team.id": team_id,
                        },
                    )
                    if tracing_enabled()
                    else contextlib.nullcontext()
                )
                with _span_cm as _otel_span:
                    if _otel_span is not None:
                        _sc = _otel_span.get_span_context()
                        if _sc.trace_id != 0:
                            trace_id = format(_sc.trace_id, "032x")
                    with agno_team_nest_under_current_span():
                        async with _invoke_semaphore:
                            # Team stream: proactive sizing only.
                            # Pre-first-chunk retry across the team
                            # event matrix is complex enough that we
                            # defer it; overflow that slips past
                            # proactive sizing surfaces as a friendly
                            # error event (existing _friendly_error
                            # path inside the loop).
                            async for chunk in team.arun(
                                arun_input,
                                session_id=session_id,
                                user_id=user_id,
                                metadata={"project_id": project_id, "authorization": jwt_token},
                                stream=True,
                                stream_events=True,
                            ):
                                chunk_count += 1

                                # --- Raw string chunks: manager's streaming tokens ---
                                if isinstance(chunk, str):
                                    full_response += chunk
                                    yield {"event": "message", "data": chunk}
                                    continue

                                event = getattr(chunk, "event", None)
                                usage_data = _extract_usage(chunk) or usage_data
                                if event is None:
                                    logger.debug(
                                        "Team chunk #%d: no event attr, skipping (type=%s)",
                                        chunk_count, type(chunk).__name__,
                                    )
                                    continue

                                # Flush buffered member text whenever the stream moves to a
                                # different event category so member responses stay coherent.
                                if event not in member_content:
                                    for buffered_event in _drain_member_buffers():
                                        yield buffered_event

                                # --- Manager text -> transcript ---
                                if event in team_content:
                                    text_chunk = _safe_content_str(chunk)
                                    text_chunk = _strip_delegation_noise(text_chunk)
                                    if text_chunk:
                                        full_response += text_chunk
                                        yield {"event": "message", "data": text_chunk}

                                # --- Tool calls (team delegations + member tools) -> inline cards ---
                                elif event in tool_start:
                                    name, aid = _get_member_identity(chunk)
                                    tool_exec = getattr(chunk, "tool", None)
                                    tc_id = getattr(tool_exec, "tool_call_id", None) or str(uuid.uuid4()) if tool_exec else str(uuid.uuid4())
                                    tc_name = getattr(tool_exec, "tool_name", "") or "" if tool_exec else ""
                                    tc_args = getattr(tool_exec, "tool_args", {}) or {} if tool_exec else {}
                                    pending_tool_calls[tc_id] = {
                                        "toolCallId": tc_id,
                                        "toolName": tc_name,
                                        "args": tc_args,
                                        "memberName": name,
                                        "memberId": aid,
                                    }
                                    yield {
                                        "event": "tool_call_start",
                                        "data": json.dumps({
                                            "toolCallId": tc_id,
                                            "toolName": tc_name,
                                            "args": tc_args,
                                            "memberName": name,
                                            "memberId": aid,
                                        }, default=str),
                                    }

                                elif event in tool_done:
                                    tool_exec = getattr(chunk, "tool", None)
                                    tool_result = _extract_tool_result(
                                        tool_exec, getattr(chunk, "content", None),
                                    )
                                    tc_id = (
                                        getattr(tool_exec, "tool_call_id", "")
                                        if tool_exec else ""
                                    )
                                    entry = pending_tool_calls.pop(tc_id, {
                                        "toolCallId": tc_id,
                                        "toolName": getattr(tool_exec, "tool_name", "") if tool_exec else "",
                                        "args": {},
                                    })
                                    name, aid = _get_member_identity(chunk)
                                    entry["result"] = tool_result
                                    entry["memberName"] = name or entry.get("memberName")
                                    entry["memberId"] = aid or entry.get("memberId")
                                    completed_tool_calls.append(entry)
                                    yield {
                                        "event": "tool_call_result",
                                        "data": json.dumps({
                                            "toolCallId": tc_id,
                                            "result": tool_result,
                                            "memberName": entry.get("memberName"),
                                            "memberId": entry.get("memberId"),
                                        }, default=str),
                                    }

                                # --- Member text -> synthetic tool-call pair (collapsed card) ---
                                elif event in member_content:
                                    text_chunk = _safe_content_str(chunk)
                                    if text_chunk:
                                        name, aid = _get_member_identity(chunk)
                                        key = _member_key(name, aid)
                                        existing = pending_member_text.get(key)
                                        if existing:
                                            existing_text = existing.get("text") or ""
                                            existing["text"] = f"{existing_text}{text_chunk}"
                                        else:
                                            pending_member_text[key] = {
                                                "memberName": name,
                                                "memberId": aid,
                                                "text": text_chunk,
                                            }

                                # --- Errors ---
                                elif event in errors:
                                    friendly = _friendly_error(
                                        _safe_content_str(chunk) or "An unknown error occurred",
                                    )
                                    yield {"event": "error", "data": friendly}

                                # --- Fallback for unrecognized events (older Agno versions) ---
                                else:
                                    event_name = _normalize_event(event)
                                    logger.debug(
                                        "Team chunk #%d: unhandled event=%s, checking fallback",
                                        chunk_count, event_name,
                                    )
                                    if event_name in (
                                        "RunContent", "RunResponseContent",
                                        "RunCompleted", "RunResponse",
                                    ):
                                        text_chunk = _safe_content_str(chunk)
                                        if text_chunk:
                                            tc_id = str(uuid.uuid4())
                                            completed_tool_calls.append({
                                                "toolCallId": tc_id,
                                                "toolName": "__member_response__",
                                                "args": {},
                                                "result": text_chunk,
                                            })
                                            yield {
                                                "event": "tool_call_start",
                                                "data": json.dumps({
                                                    "toolCallId": tc_id,
                                                    "toolName": "__member_response__",
                                                    "args": {},
                                                }, default=str),
                                            }
                                            yield {
                                                "event": "tool_call_result",
                                                "data": json.dumps({
                                                    "toolCallId": tc_id,
                                                    "result": text_chunk,
                                                }, default=str),
                                            }

                    for buffered_event in _drain_member_buffers():
                        yield buffered_event

                    full_response = _strip_delegation_noise(full_response).strip()

                    if not full_response and completed_tool_calls:
                        tool_names = [
                            tc.get("toolName") for tc in completed_tool_calls
                            if tc.get("toolName") and tc.get("toolName") != "__member_response__"
                        ]
                        deduped = list(dict.fromkeys(tool_names))
                        suffix = f" ({', '.join(deduped)})" if deduped else ""
                        full_response = (
                            f"I executed the requested tools{suffix}. "
                            "Please see the results above."
                        )
                        yield {"event": "message", "data": full_response}

                    latency_ms = int((time.monotonic() - t0) * 1000)
                    asyncio.create_task(_persist_stream_session(
                        team_id, user_id, session_id, body.message, full_response,
                        latency_ms, manager_model, usage_data, None, completed_tool_calls,
                        trace_id=trace_id,
                    ))
                    done_team: dict = {
                        "sessionId": session_id,
                        "latencyMs": latency_ms,
                        "modelName": manager_model,
                        "usage": usage_data,
                        "citations": None,
                    }
                    if trace_id:
                        done_team["traceId"] = trace_id
                    yield {
                        "event": "done",
                        "data": json.dumps(done_team),
                    }
            except Exception as e:
                logger.exception(
                    "Stream invocation failed for team %s (session=%s)",
                    team_id, session_id,
                )
                yield {"event": "error", "data": _friendly_error(str(e))}

        finally:
            agentstudio_phoenix_project_id.reset(_phoenix_proj_tok)

    return EventSourceResponse(event_generator(), ping=15)


@app.post(
    "/api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/async",
    response_model=AsyncInvokeResponse,
)
async def invoke_team_async(
    project_id: str, team_id: str, body: InvokeRequest, request: Request
):
    rid = activity_request_id(request)
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    jwt_token = request.headers.get("Authorization", "")
    team_config = await _fetch_team_config(project_id, team_id)
    validate_project_access(project_id, user_ctx, team_config)
    team_config = await _apply_team_model_override(body, team_config, project_id)

    task_id = await task_manager.create_task(project_id, team_id)
    activity(
        logger,
        "invoke_team_async_queued",
        request_id=rid,
        project_id=project_id,
        team_id=team_id,
        task_id=task_id,
        user_id=user_id,
        has_model_override=bool(body.modelId),
    )

    async def _run_async():
        with phoenix_project_scope(project_id):
            try:
                session_id = body.sessionId or str(uuid.uuid4())
                team = await team_factory.create_from_config(
                    team_config,
                    project_id,
                    user_label=user_ctx.get("user_email") or user_id,
                )
                manager_model = getattr(team, "_model_name", None)
                arun_input, cm_result = await _build_arun_input(
                    team, body.message, "team", team_id, user_id, session_id,
                )
                logger.info(
                    "Async team task %s: context_manager prepared strategy=%s "
                    "est_tokens=%d ctx_window=%d (%s) trimmed_turns=%d session=%s",
                    task_id,
                    cm_result.prepared.strategy_used,
                    cm_result.prepared.est_input_tokens,
                    cm_result.prepared.context_window,
                    cm_result.prepared.context_window_source,
                    cm_result.prepared.trimmed_turn_count,
                    session_id,
                )
                t0 = time.monotonic()
                _span_cm = (
                    _tracer.start_as_current_span(
                        f"invoke_team_{team_id}",
                        attributes={
                            "session.id": session_id,
                            "project.id": project_id,
                            "team.id": team_id,
                        },
                    )
                    if tracing_enabled()
                    else contextlib.nullcontext()
                )
                with _span_cm:
                    with agno_team_nest_under_current_span():
                        async with _invoke_semaphore:
                            try:
                                run_response = await team.arun(
                                    arun_input,
                                    session_id=session_id,
                                    user_id=user_id,
                                    metadata={"project_id": project_id, "authorization": jwt_token},
                                )
                            except Exception as team_exc:
                                retry_input = (
                                    _retry_input_for_overflow(cm_result)
                                    if is_context_overflow_error(team_exc) else None
                                )
                                if retry_input is None:
                                    raise
                                logger.warning(
                                    "Async team task %s: context overflow; retrying with aggressive trim",
                                    task_id,
                                )
                                activity(
                                    logger,
                                    "context_overflow_reactive_retry",
                                    entity_id=team_id,
                                    session_id=session_id,
                                    outcome="team_async_retry",
                                )
                                run_response = await team.arun(
                                    retry_input,
                                    session_id=session_id,
                                    user_id=user_id,
                                    metadata={"project_id": project_id, "authorization": jwt_token},
                                )
                latency_ms = int((time.monotonic() - t0) * 1000)
                response_text = (
                    run_response.content
                    if hasattr(run_response, "content")
                    else str(run_response)
                )
                usage = _extract_usage(run_response)
                await session_store.append_message(
                    team_id, user_id, session_id, "user", body.message
                )
                await session_store.append_message(
                    team_id, user_id, session_id, "assistant", response_text,
                    metadata={"latencyMs": latency_ms, "modelName": manager_model, "usage": usage},
                )
                await task_manager.complete_task(
                    task_id,
                    {
                        "response": response_text,
                        "sessionId": session_id,
                        "latencyMs": latency_ms,
                        "modelName": manager_model,
                        "usage": usage,
                    },
                )
            except Exception as e:
                logger.exception("Async team task %s failed", task_id)
                await task_manager.fail_task(task_id, str(e))

    asyncio.create_task(_run_async())
    return AsyncInvokeResponse(taskId=task_id)


@app.get("/api/v1/projects/{project_id}/agent-teams/{team_id}/sessions")
async def list_team_sessions(project_id: str, team_id: str, request: Request):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    sessions = await session_store.list_sessions(team_id, user_id)
    return {"sessions": sessions}


@app.get(
    "/api/v1/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}"
)
async def get_team_session(
    project_id: str, team_id: str, session_id: str, request: Request
):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    messages = await session_store.get_session_messages(team_id, user_id, session_id)
    meta = await session_store.get_session_meta(team_id, user_id, session_id)
    return {"sessionId": session_id, "messages": messages, **meta}


@app.patch(
    "/api/v1/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}"
)
async def rename_team_session(
    project_id: str,
    team_id: str,
    session_id: str,
    body: RenameSessionRequest,
    request: Request,
):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    await session_store.rename_session(team_id, user_id, session_id, body.name)
    activity(
        logger,
        "session_rename",
        request_id=activity_request_id(request),
        project_id=project_id,
        entity="team",
        team_id=team_id,
        session_id=session_id,
        name_len=len(body.name or ""),
    )
    return {"sessionId": session_id, "name": body.name}


@app.delete(
    "/api/v1/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}"
)
async def delete_team_session(
    project_id: str, team_id: str, session_id: str, request: Request
):
    user_ctx = get_user_context(request)
    user_id = user_ctx["user_id"]
    await session_store.delete_session(team_id, user_id, session_id)
    activity(
        logger,
        "session_delete",
        request_id=activity_request_id(request),
        project_id=project_id,
        entity="team",
        team_id=team_id,
        session_id=session_id,
    )
    return {"deleted": True}
