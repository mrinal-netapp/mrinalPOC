"""Knowledge-base retrieval function.

The concrete callable behind any :class:`~agent_service_maf.tools.binding.FunctionBinding`
with ``function_ref="kb_retrieve"``. Multiple bindings may reuse this
function with different pinned ``params`` (e.g. one binding per tenant
or per knowledge base).

Endpoint URL is read from the ``KB_ENDPOINT_URL`` environment variable
at module import (with a sane dev-host default), so ops can rotate it
without a code change.

Two-token model (§G2 of the identity-propagation plan)
------------------------------------------------------

Every outbound call to ``kb-retrieval-service`` applies the §3
two-token-model header shape via
:func:`agent_service_maf.mcp._identity_transport.build_identity_headers`:

* ``Authorization: Bearer ${KB_SERVICE_TOKEN}`` when configured -- the
  per-deployment service-account token that proves "this is MAF
  calling". Sourced from the env var ``KB_SERVICE_TOKEN`` (secret).
* ``Authorization: Bearer <user_jwt>`` when no service token is
  configured -- legacy-compat fallback so kb-retrieval-service on
  the old shape keeps working until it's migrated.
* ``X-User-Token`` always carries the user JWT alongside, so
  downstream services can opt in to the new contract at their own
  pace.
* ``X-User-ID`` / ``X-Project-ID`` / ``X-User-Email`` / ``X-User-Name``
  for attribution + per-user authorization. (Legacy only sent
  ``X-Project-ID``; this expands the contract additively.)

Identity is read from the active
:class:`~agent_service_maf.core.identity.IdentityContext` via the
ContextVar; the LLM cannot influence which user the tool acts on
(§G3 lint guard).

Sanitization (§G5)
------------------

Chunk text returned by the upstream is run through
:func:`sanitize_chunk_content` before being concatenated into the
LLM-facing response. Citations (``kbCitations``) come out unchanged
-- only the ``text`` going into the LLM context needs scrubbing.

A module-level ``httpx.AsyncClient`` keeps the TCP/TLS connection
warm across calls -- this is the only meaningful per-request perf
difference between the registry-backed and declarative approaches.
"""

from __future__ import annotations

import json
import os
import re
from typing import Annotated, Any

import httpx
import structlog

from agent_service_maf.core.identity import get_current_identity
from agent_service_maf.mcp._identity_transport import (
    HDR_AUTHORIZATION,
    build_identity_headers,
)
from agent_service_maf.tools.functions import FunctionToolResult, register_function

logger = structlog.get_logger(__name__)


_DEFAULT_ENDPOINT = "https://agent-studio-nemo-apim-dev.azure-api.net/retrieval/invoke"
_ENDPOINT_URL = os.environ.get("KB_ENDPOINT_URL", _DEFAULT_ENDPOINT)
_TIMEOUT_SECONDS = float(os.environ.get("KB_TIMEOUT_SECONDS", "30"))
_MAX_BYTES = int(os.environ.get("KB_MAX_RESPONSE_BYTES", "65536"))


def _service_token() -> str | None:
    """Read the static KB service-account token from env at call time.

    Re-reading per call (rather than caching at import time) means
    operators can rotate the token without a process restart -- the
    new value is picked up on the next request.

    This is the *explicit override* path: when ``KB_SERVICE_TOKEN`` is
    set it wins over the minted Keycloak service JWT (see
    :func:`_resolve_service_token`). Left unset in normal deployments
    -- the Keycloak client-credentials flow supplies a fresh,
    auto-rotating bearer instead.
    """
    value = os.environ.get("KB_SERVICE_TOKEN", "").strip()
    return value or None


# Process-wide Keycloak service-account client, injected at app startup
# via :func:`set_kb_service_auth`. When present, ``kb_retrieve`` mints a
# short-lived service JWT (``aud=agent-studio-api``) for the outbound
# ``Authorization`` header so the call satisfies the in-mesh
# ``mesh-require-jwt`` AuthorizationPolicy fronting kb-retrieval-service
# in the JWT-gated ``agentstudio-services`` namespace. Without it, a
# token-less / user-token hop is denied by Envoy with
# ``403 "RBAC: access denied"``.
#
# Typed loosely (``Any``) to avoid importing ``ServiceAccountClient``
# here -- keeps this leaf tool module free of a config-layer import and
# sidesteps any import cycle. The only contract required is an awaitable
# ``auth_headers() -> {"Authorization": "Bearer <jwt>"}``.
_SERVICE_AUTH: Any | None = None


def set_kb_service_auth(client: Any | None) -> None:  # noqa: ANN401 - duck-typed
    """Register the Keycloak service-account client for KB calls.

    Called once from the FastAPI lifespan after the shared
    :class:`~agent_service_maf.config.service_auth.ServiceAccountClient`
    is constructed. Idempotent; passing ``None`` clears it (used by
    tests to restore the default no-service-token behaviour).
    """
    global _SERVICE_AUTH
    _SERVICE_AUTH = client


async def _resolve_service_token() -> str | None:
    """Return the bearer to use for the outbound ``Authorization`` header.

    Resolution order:

    1. ``KB_SERVICE_TOKEN`` env (explicit operator override / pinned token).
    2. A freshly-minted Keycloak service JWT from the injected
       :data:`_SERVICE_AUTH` client (the normal in-cluster path). The
       client caches + refreshes the token, so this is cheap per call.
    3. ``None`` -- lets :func:`build_identity_headers` fall back to the
       legacy user-JWT-as-Authorization shape (dev / no-auth mode).

    A mint failure degrades to ``None`` (legacy fallback) rather than
    raising, so a transient Keycloak blip surfaces as the upstream's own
    auth error instead of masking the KB result behind a config error.
    """
    static = _service_token()
    if static:
        return static

    client = _SERVICE_AUTH
    if client is None:
        return None
    try:
        headers = await client.auth_headers()
    except Exception as exc:  # noqa: BLE001 - degrade to legacy fallback
        logger.warning("kb_retrieve_service_auth_failed", error=str(exc))
        return None
    authorization = headers.get(HDR_AUTHORIZATION, "")
    prefix = "Bearer "
    if authorization.startswith(prefix):
        return authorization[len(prefix) :] or None
    return authorization or None


# §G5 — prompt-injection-style markers to neutralize in chunk text
# before it lands in the LLM context. Matches the legacy
# ``sanitize_chunk_content`` shape; kept deliberately narrow so the
# LLM still sees a faithful representation of the source content.
_INJECTION_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(?i)\bignore\b[^\n]*\b(previous|prior|above)\b[^\n]*\binstructions?\b"),
    re.compile(r"(?i)\bdisregard\b[^\n]*\b(previous|prior|above)\b[^\n]*\binstructions?\b"),
    re.compile(r"(?i)\bsystem\s*[:>]\s*"),
    re.compile(r"(?i)\b<\s*/?\s*system\s*>\b"),
]


def sanitize_chunk_content(text: str) -> str:
    """Neutralize obvious prompt-injection sequences in KB chunk text.

    Matches the legacy ``sanitize_chunk_content`` in
    ``AgentStudio/src/nemo/agent-service/src/sanitize.py``. Applied
    only to the LLM-facing ``text``; ``kbCitations`` are passed
    through unchanged since they carry no LLM-controlled content.

    Args:
        text: Raw chunk text from the upstream KB.

    Returns:
        Text with known injection markers replaced by neutral
        placeholders. Returns the original value for non-string
        inputs to keep call sites simple.
    """
    if not isinstance(text, str):
        return text  # type: ignore[unreachable]
    out = text
    for pattern in _INJECTION_PATTERNS:
        out = pattern.sub("[redacted-instruction]", out)
    return out


def sanitize_kb_name(name: str) -> str:
    """Normalize a KB name for safe display.

    Trims whitespace + collapses internal whitespace runs. Mirrors
    legacy ``sanitize_kb_name``; KB names appear in user-visible
    citation footers, so a hostile upstream cannot inject newlines /
    control characters to break the UI.
    """
    if not isinstance(name, str):
        return name  # type: ignore[unreachable]
    return re.sub(r"\s+", " ", name).strip()


def wrap_kb_data(chunks: list[Any]) -> list[Any]:
    """Apply §G5 sanitization to each chunk in-place-equivalent.

    Returns a new list of sanitized chunk dicts (defensive copy);
    non-dict chunks pass through unchanged.
    """
    sanitized: list[Any] = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            sanitized.append(chunk)
            continue
        copy = dict(chunk)
        if "text" in copy:
            copy["text"] = sanitize_chunk_content(copy["text"])
        if "knowledgeBaseName" in copy:
            copy["knowledgeBaseName"] = sanitize_kb_name(copy["knowledgeBaseName"])
        sanitized.append(copy)
    return sanitized


# Lazy module-level client; instantiated on first call so test runs
# don't open sockets at import time.
_CLIENT: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Return the process-wide pooled httpx client (lazy-init)."""
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = httpx.AsyncClient(timeout=_TIMEOUT_SECONDS)
    return _CLIENT


@register_function("kb_retrieve")
async def kb_retrieve(
    query: Annotated[str, "Natural-language query against the knowledge base."],
    *,
    params: dict[str, Any],
) -> FunctionToolResult:
    """Search a knowledge base and return matching chunks plus citations.

    All deployment knobs live in ``params`` (the binding's pinned dict),
    so the LLM never sees or supplies them. The function decides per
    key whether to send it as a body field, an HTTP header, or
    elsewhere:

    * ``kbId`` / ``projectId`` (required) → request body.
    * ``topK`` (optional) → request body when the binding sets it.
    * ``similarityThreshold`` (optional) → emitted as BOTH
      ``similarityThreshold`` (Cloud APIM legacy key) and ``minScore``
      (in-cluster Rust kb-retrieval-service key) so the same build
      works against either upstream.
    * ``searchMode`` (optional, ``"semantic" | "hybrid" | "fts"``) →
      request body, forwarded as-is.
    * ``headers`` (optional ``dict[str, str]``) → forwarded as HTTP
      headers on every call (e.g. tenant-context tokens).

    The default description here is overridden by
    ``FunctionBinding.description`` when surfaced to the LLM, so each
    binding presents itself with its own intent (e.g. "Search the IETF
    RFC knowledge base").

    Args:
        query: User's natural-language query.
        params: Binding-pinned parameters. See the body of this
            docstring for the recognised keys.

    Returns:
        A :class:`FunctionToolResult` whose ``text`` is the LLM-facing
        JSON array of chunks (truncated to ``KB_MAX_RESPONSE_BYTES``;
        empty results yield ``"[]"``) and whose ``kb_citations`` is one
        :class:`~agent_service_maf.core.interfaces.KbCitation` dict per
        chunk in the response, mapped from the upstream
        ``SearchResult`` shape (``id`` → internal ``chunkId``;
        ``documentId`` / ``source`` / ``downloadUrl`` /
        ``knowledgeBaseId`` / ``knowledgeBaseName`` / ``score`` →
        identically named camelCase fields).

    Raises:
        ValueError: When required pinned params are missing.
        RuntimeError: When the upstream returns a non-2xx status. The
            message includes the HTTP status and a truncated body so
            operators can diagnose without grepping.
    """
    kb_id = params.get("kbId")
    project_id = params.get("projectId")
    if not kb_id or not project_id:
        raise ValueError(
            "kb_retrieve requires 'kbId' and 'projectId' in binding params; "
            f"got params keys: {sorted(params)}"
        )

    body: dict[str, Any] = {
        "query": query,
        "kbId": kb_id,
        "projectId": project_id,
    }
    # Optional knobs are pinned by the binding (server-wins, invisible
    # to the LLM). Include them in the body only when the binding set
    # them; omission lets the upstream default apply.
    if "topK" in params and params["topK"] is not None:
        body["topK"] = params["topK"]
    if "similarityThreshold" in params and params["similarityThreshold"] is not None:
        # Two upstream shapes accept the threshold under different keys:
        #   * Cloud APIM (legacy) reads ``similarityThreshold``.
        #   * In-cluster Rust kb-retrieval-service reads ``minScore``
        #     (its ``SearchRequest`` is camelCase-renamed from
        #     ``min_score`` and has no ``similarityThreshold`` field).
        # Both upstreams tolerate unknown JSON keys, so sending both
        # lets the same agent-service-maf build talk to either deployment
        # without a config switch.
        thr = params["similarityThreshold"]
        body["similarityThreshold"] = thr
        body["minScore"] = thr
    if "searchMode" in params and isinstance(params["searchMode"], str) and params["searchMode"]:
        # Per-agent ragConfig.searchMode (``"semantic" | "hybrid" | "fts"``)
        # forwarded as-is; the Rust service falls back to its configured
        # default when omitted.
        body["searchMode"] = params["searchMode"]

    # §G2 — start from any binding-pinned static headers, then layer
    # the §3 two-token-model identity headers on top so the per-call
    # identity always wins over a stale binding header. The binding
    # may still carry tenant-context / feature-flag headers; only
    # the auth + identity envelope is owned by the request scope.
    request_headers: dict[str, str] = {}
    raw_headers = params.get("headers")
    if isinstance(raw_headers, dict):
        request_headers = {str(k): str(v) for k, v in raw_headers.items()}

    identity = get_current_identity()
    # Prefer a minted Keycloak service JWT (aud=agent-studio-api) so the
    # call clears the in-mesh mesh-require-jwt AuthorizationPolicy that
    # fronts kb-retrieval-service; falls back to the static env token,
    # then to the legacy user-JWT-as-Authorization shape.
    service_token = await _resolve_service_token()
    for key, value in build_identity_headers(identity, service_token).items():
        request_headers[key] = value

    # Two upstream shapes are supported via env-configured URL:
    #
    #   1. Cloud APIM (legacy): a single body-based endpoint
    #      (e.g. ``…/retrieval/invoke``) — POST as-is, IDs travel in the
    #      JSON body alongside ``query``.
    #   2. In-cluster Rust kb-retrieval-service: path-based routes
    #      (``/api/v1/projects/{projectId}/knowledgebases/{kbId}/search``)
    #      — templating substitutes the path segments before the call.
    #      The body still carries the IDs so the legacy contract stays
    #      truthy and per-call logging/auditing isn't degraded.
    url = (
        _ENDPOINT_URL.format(projectId=project_id, kbId=kb_id)
        if "{" in _ENDPOINT_URL
        else _ENDPOINT_URL
    )
    client = _get_client()
    resp = await client.post(url, json=body, headers=request_headers)
    if resp.status_code >= 400:
        raise RuntimeError(f"kb_retrieve HTTP {resp.status_code} from {url}: {resp.text[:256]}")

    text = resp.text

    # Normalise the wire shape to a top-level JSON array of chunks and,
    # in the same pass, extract per-chunk citations. The upstream wraps
    # results as ``{"results": [...]}`` (the canonical SearchResult[]
    # envelope) or sometimes ``{"chunks": [...]}`` / ``{"data": [...]}``
    # / ``{"items": [...]}``; unwrap once here so every downstream
    # consumer — passthrough agents, the relevance scorer, the
    # summarizer, the sequential analyzer — sees the same clean array
    # shape. Non-JSON or unexpected shapes pass through unchanged and
    # the citation list stays empty.
    chunks: list[Any] = []
    # Track whether we actually located a list envelope (even an empty
    # one). Without this, the post-pass below cannot tell ``empty list
    # found`` (``"[]"`` per docstring) apart from ``no list envelope
    # detected`` (leave ``text`` as the raw upstream wrapper).
    found_list_envelope = False
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            for key in ("results", "chunks", "data", "items"):
                inner = parsed.get(key)
                if isinstance(inner, list):
                    chunks = inner
                    found_list_envelope = True
                    break
        elif isinstance(parsed, list):
            chunks = parsed
            found_list_envelope = True
    except json.JSONDecodeError:
        pass

    # §G5 — citations come straight from the raw chunks (they don't
    # carry LLM-controlled text). The LLM-facing ``text`` is built
    # from the sanitized copy. Always re-serialize when we unwrapped a
    # list (even an empty one) so an empty ``{"results": []}`` becomes
    # ``"[]"`` per the docstring contract, instead of leaking the raw
    # wrapper object into the LLM context.
    #
    # ``kb_id`` is in scope from binding params — pass it through so the
    # citations carry the owning KB even when the upstream chunk's
    # ``knowledgeBaseId`` field is null. The UI's Statistics panel groups
    # retrievedChunks by knowledgeBaseId; without this, every chunk was
    # being silently dropped from the aggregation.
    kb_citations = _build_citations(
        chunks,
        fallback_kb_id=str(kb_id) if kb_id else None,
    )
    if found_list_envelope:
        sanitized_chunks = wrap_kb_data(chunks)
        text = json.dumps(sanitized_chunks)

    if len(text) > _MAX_BYTES:
        text = text[:_MAX_BYTES] + " [TRUNCATED]"

    # Rough token estimate for the UI "Context window usage" row —
    # English text averages ~4 chars/token across BPE tokenizers, so
    # divide the final LLM-facing text length by 4. This is the same
    # heuristic used elsewhere in the repo and is good enough for a
    # usage bar; if a precise count matters, the gateway returns
    # promptTokens on the LLM response and the UI reads that instead.
    tokens_used = max(1, len(text) // 4) if text else 0

    return FunctionToolResult(
        text=text,
        kb_citations=kb_citations,
        tool_type="kb",
        tokens_used=tokens_used,
    )


def _build_citations(
    chunks: list[Any],
    *,
    fallback_kb_id: str | None = None,
) -> list[dict[str, Any]]:
    """Map each ``SearchResult`` chunk to a wire-shape ``KbCitation`` dict.

    The SearchResult schema from openapi.yaml carries ``id``,
    ``documentId``, ``source``, ``downloadUrl``, ``knowledgeBaseId``,
    ``knowledgeBaseName``, ``score`` -- exactly the fields
    :class:`~agent_service_maf.core.interfaces.KbCitation` needs. ``id``
    becomes the internal ``chunkId`` (dedup key, never serialized to
    the wire). The ``text`` / ``chunkIndex`` / ``metadata`` fields are
    LLM-context concerns and are not part of the UI citation footer,
    so they're dropped here.

    Non-dict chunks (or chunks missing the required ``source`` field)
    are skipped silently -- :meth:`ResponseBuilder._coerce_kb_citations`
    also does Pydantic validation and would log + drop them anyway, but
    pre-filtering keeps the warning log clean for the common shape.

    Args:
        chunks: Raw SearchResult dicts from the upstream service.
        fallback_kb_id: KB id from the binding context. Used when the
            upstream chunk's own ``knowledgeBaseId`` is null/missing --
            kb-retrieval-service today serializes those as null even
            though the calling endpoint already scopes by KB.
    """
    citations: list[dict[str, Any]] = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        source = chunk.get("source")
        if not source:
            continue
        citation: dict[str, Any] = {"source": source}
        # Map straight-through camelCase fields. The wire schema for
        # KbCitation accepts camelCase aliases (CamelCaseModel), so we
        # emit camelCase here to skip a snake/camel hop.
        for src_key in (
            "documentId",
            "downloadUrl",
            "knowledgeBaseId",
            "knowledgeBaseName",
            "score",
        ):
            value = chunk.get(src_key)
            if value is not None:
                citation[src_key] = value
        # Fill the kb id from the binding context when the chunk left it
        # null. Without this the UI's per-KB chunk aggregation drops
        # every entry (it groups by ``knowledgeBaseId`` and skips empty).
        if "knowledgeBaseId" not in citation and fallback_kb_id:
            citation["knowledgeBaseId"] = fallback_kb_id
        chunk_id = chunk.get("id")
        if chunk_id is not None:
            citation["chunkId"] = chunk_id
        citations.append(citation)
    return citations


def _reset_client_for_tests() -> None:
    """Test hook — drops the cached client so a fresh one is built."""
    global _CLIENT
    if _CLIENT is not None:
        # Best-effort close; tests run async and may not have a loop here.
        _CLIENT = None
