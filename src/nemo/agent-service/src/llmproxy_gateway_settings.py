"""LLM proxy gateway (Bifrost) URL / auth helpers.

This module is named ``llmproxy_gateway_settings`` (not ``gateway_settings``)
to make the meaning unambiguous: "gateway" alone could be confused with
the AgentStudio api-gateway / apigateway-service. Everything here is about
the **LLM proxy gateway** (Bifrost).

Naming note on the wire-side fields (``gatewayApiKey``, ``gatewayModelId``,
``gatewayBindingName``, ``gatewayProvider``): those are still emitted by
config-service in camelCase JSON with the ambiguous ``gateway`` prefix.
A cross-service rename of those JSON fields to ``llmproxyGateway*`` is a
separate follow-up — see ``docs/design/bifrost-migration.md``. Until that
lands, ``llmproxy_gateway_api_key_for_model`` /
``resolve_llmproxy_gateway_model_id`` read the existing wire keys verbatim.

Bifrost exposes its OpenAI-compatible chat-completions API under the
``/litellm/v1`` path — that path name is Bifrost's own (it's a
LiteLLM-API-compatible shim) and is not a LiteLLM dependency.
AgentStudio routes all inference through the Bifrost gateway.
"""

from __future__ import annotations

from .config import settings


def llmproxy_gateway_base_url() -> str:
    """Base URL of the LLM proxy gateway (Bifrost). Trailing slash stripped."""
    return (settings.LLM_GATEWAY_URL or "").rstrip("/")


def llmproxy_gateway_chat_completions_base() -> str:
    """Base URL for the LLM-proxy-gateway (Bifrost) OpenAI-compatible SDK endpoint."""
    return f"{llmproxy_gateway_base_url()}/litellm/v1"


def chat_completions_url() -> str:
    """HTTP URL for direct chat completion calls (summarizer)."""
    return f"{llmproxy_gateway_chat_completions_base()}/chat/completions"


def llmproxy_gateway_api_key() -> str:
    """Cluster-wide LLM-proxy-gateway (Bifrost) master key, if configured.

    Today AgentStudio's Bifrost is deployed without a master key (no
    ``auth:`` block in charts/bifrost/templates/configmap.yaml), so this
    is normally empty. Per-project model inference uses the project's
    virtual-key bearer (via :func:`llmproxy_gateway_api_key_for_model`);
    the master key here is only consumed by the few non-per-project
    paths that still talk to Bifrost directly -- :func:`mcp_auth_headers`
    for the aggregated ``/mcp`` endpoint, and the summarizer's direct
    HTTP chat-completion calls.
    """
    return settings.LLM_GATEWAY_API_KEY


class MissingProjectVirtualKeyError(RuntimeError):
    """Raised when a model belongs to a project but the project has no
    Bifrost virtual-key token available.

    Indicates one of:
      * ProjectInitWorkflow Step 0 (Bifrost team + VK setup) has not
        finished yet.
      * The K8s Secret holding the VK token was deleted out of band.
      * Some hand-rolled model registration produced a model row whose
        owning project pre-dates per-project VK governance.

    Surfaced loudly so operators / users know to retry project init
    rather than silently fall back to a placeholder, which would lose
    team-scoped routing and any future budget/RL enforcement.
    """


def llmproxy_gateway_api_key_for_model(model_info: dict) -> str:
    """Per-project LLM-proxy-gateway (Bifrost) virtual-key bearer token
    to send with this model's chat completions.

    Returned to the caller as the ``api_key`` field on the Agno LiteLLM
    model object, then propagated by the Python LiteLLM SDK (used here
    only as a transport library) onto the outbound HTTP request to
    Bifrost's ``/litellm/v1`` OpenAI-compatible endpoint. The VK lives
    in the K8s Secret ``as-proj-<projectId>-vk``; config-service reads
    it on ``GET /models/:id`` and inlines it onto the model row as
    ``gatewayApiKey`` (camelCase wire field).

    Raises :class:`MissingProjectVirtualKeyError` when ``model_info``
    has no ``gatewayApiKey`` set. We deliberately do NOT fall back to
    the cluster master key (``LLM_GATEWAY_API_KEY``) here -- doing so
    would silently bypass team-scoped routing rules and any future
    per-project budgets / rate-limits. Failing loudly forces operators
    to fix the underlying issue (project VK Secret missing, project
    init didn't complete Step 0, etc.).

    Wire-field naming note: ``gatewayApiKey`` (camelCase) and
    ``gateway_api_key`` (snake_case fallback) below are read as-is
    because they match what config-service currently sends on the
    wire. Renaming those wire fields to ``llmproxyGatewayApiKey``
    needs a cross-service migration (DB column on ``models`` table +
    OpenAPI specs + GUI + this file).
    """
    token = (
        model_info.get("gatewayApiKey")
        or model_info.get("gateway_api_key")
    )
    if token:
        return str(token)
    model_id = model_info.get("id") or model_info.get("providerModelId") or "(unknown)"
    project_id = model_info.get("projectId") or "(unknown)"
    raise MissingProjectVirtualKeyError(
        f"No gatewayApiKey returned by config-service for model "
        f"{model_id} (project {project_id}). The project's Bifrost "
        "virtual-key Secret is missing - has ProjectInitWorkflow "
        "completed Step 0 for this project?"
    )


def resolve_llmproxy_gateway_model_id(
    model_alias: str,
    model_info: dict | None = None,
) -> str:
    """Resolve the Bifrost-ready model id from a model_info dict.

    Config-service bakes the LLM-proxy-gateway-side provider prefix
    into ``gatewayModelId`` (camelCase wire field) at registration
    time (e.g. ``azure/gpt-4o-mini-model``), so callers prefer that
    value verbatim. We fall back to the bare ``providerModelId`` only
    as a last resort — that case will work for models registered via
    legacy paths only after the lazy backfill in ``GET /models/:id``
    populates the field on read; for transient cases the gateway will
    respond with "provider is required" and the caller should
    re-register or refresh the cache.

    Wire-field naming note: ``gatewayModelId`` (and snake_case
    ``gateway_model_id`` fallback) are read as-is for the same reason
    described on :func:`llmproxy_gateway_api_key_for_model`.
    """
    if model_info:
        gateway_id = (
            model_info.get("gatewayModelId")
            or model_info.get("gateway_model_id")
        )
        if gateway_id:
            return str(gateway_id)
        provider_id = (
            model_info.get("providerModelId")
            or model_info.get("provider_model_id")
        )
        if provider_id:
            return str(provider_id)
    return model_alias


def llmproxy_gateway_model_id_with_sdk_prefix(
    llmproxy_gateway_model_id: str,
    model_info: dict | None = None,  # noqa: ARG001 - retained for ABI parity
) -> str:
    """Model id sent to the LLM proxy gateway (Bifrost) on every request,
    wrapped in the ``openai/`` SDK-dispatch prefix.

    The provider hint Bifrost expects (``<bifrost-provider>/<model>``) is
    baked into ``llmproxy_gateway_model_id`` at registration time by
    config-service (see ``buildGatewayModelId`` in
    ``bifrostProviderOps.ts``). This function only adds the
    ``openai/`` outer prefix that the Python LiteLLM SDK (used inside
    Agno as a transport library) needs to dispatch through its OpenAI
    provider plugin. The LiteLLM SDK strips the ``openai/`` segment
    before forwarding to Bifrost, leaving the
    ``<bifrost-provider>/<model>`` form intact on the wire.

    Idempotent: returns the input unchanged when it already starts with
    ``openai/``.
    """
    if not llmproxy_gateway_model_id:
        return llmproxy_gateway_model_id
    if llmproxy_gateway_model_id.startswith("openai/"):
        return llmproxy_gateway_model_id
    return f"openai/{llmproxy_gateway_model_id}"


def mcp_url_for_server(_server_name: str) -> str:
    """Aggregated MCP endpoint at the LLM proxy gateway (Bifrost).

    Tools are prefixed by Bifrost client name.
    """
    return f"{llmproxy_gateway_base_url()}/mcp"


def mcp_auth_headers() -> dict[str, str]:
    """Auth headers for direct calls to the LLM proxy gateway (Bifrost)."""
    key = llmproxy_gateway_api_key()
    if not key:
        return {}
    return {
        "Authorization": f"Bearer {key}",
        "x-api-key": key,
    }
