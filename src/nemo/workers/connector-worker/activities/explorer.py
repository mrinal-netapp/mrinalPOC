"""Explorer activities: ExplorerAction dispatcher and ResolveResource."""
from observability_client_runtime import get_logger
import os
from typing import Any, Dict

import requests
from temporalio import activity

from .credentials import resolve_credential
from .activity_logging import log_activity_start, log_activity_result
from adapters import registry
from adapters.base import ExplorerResponse, ExplorerError

logger = get_logger()


@activity.defn(name="ExplorerAction")
def explorer_action(input: dict) -> dict:
    """Single dispatcher activity. Resolves credential, looks up adapter by provider,
    calls adapter.execute(). Never throws for business errors; returns error envelope."""
    log_activity_start(input)

    provider = input.get("provider", "")
    action = input.get("action", "")
    connector_config = input.get("connectorConfig", {})
    payload = input.get("payload", {})
    project_id = input.get("projectId", "")
    credential_id = input.get("credentialId", "")
    config_service_url = input.get("configServiceUrl", "")
    connector_id = input.get("connectorId", "")

    logger.info(
        "ExplorerAction: provider=%s action=%s connectorId=%s",
        provider, action, connector_id,
    )

    adapter = registry.get(provider)
    if not adapter:
        resp = ExplorerResponse(
            error=ExplorerError("ADAPTER_NOT_FOUND", f"No adapter registered for provider '{provider}'"),
        )
        result = resp.to_dict()
        log_activity_result(result)
        return result

    activity.heartbeat("resolving-credential")
    try:
        credential = resolve_credential(config_service_url, project_id, credential_id)
    except Exception as e:
        logger.exception("ExplorerAction: credential resolution failed")
        resp = ExplorerResponse(
            error=ExplorerError("CREDENTIAL_ERROR", f"Failed to resolve credential: {e}"),
        )
        result = resp.to_dict()
        log_activity_result(result, error=e)
        return result

    activity.heartbeat("executing-adapter")
    try:
        resp = adapter.execute(connector_config, credential, action, payload)
    except Exception as e:
        logger.exception("ExplorerAction: adapter.execute failed")
        resp = ExplorerResponse(
            error=ExplorerError("PROVIDER_ERROR", str(e)),
        )

    result = resp.to_dict()
    log_activity_result(result)
    activity.heartbeat("done")
    return result


@activity.defn(name="ResolveResource")
def resolve_resource(input: dict) -> dict:
    """Resolve effective config from connector config + resource selector.
    Used only by the acquisition workflow, not by explorer sessions."""
    log_activity_start(input)

    provider = input.get("provider", "")
    connector_config = input.get("connectorConfig", {})
    resource_selector = input.get("resourceSelector", {})
    project_id = input.get("projectId", "")
    credential_id = input.get("credentialId", "")
    config_service_url = input.get("configServiceUrl", "")
    scope = input.get("scope", "resource")

    if scope == "account" and not resource_selector:
        return {
            "success": False,
            "error": "resourceSelector is required for scope=account connectors",
        }

    adapter = registry.get(provider)
    if not adapter:
        return {
            "success": False,
            "error": f"No adapter registered for provider '{provider}'",
        }

    try:
        credential = resolve_credential(config_service_url, project_id, credential_id)
    except Exception as e:
        logger.exception("ResolveResource: credential resolution failed")
        return {"success": False, "error": f"Failed to resolve credential: {e}"}

    try:
        effective_config = adapter.resolve(connector_config, credential, resource_selector)
    except Exception as e:
        logger.exception("ResolveResource: adapter.resolve failed")
        return {"success": False, "error": str(e)}

    result = {"success": True, "effectiveConfig": effective_config}
    log_activity_result(result)
    return result


@activity.defn(name="TestProviderConnection")
def test_provider_connection(input: dict) -> dict:
    """Generic provider-test activity: invokes adapter.execute(action='testConnection').

    Used by the workflow-engine ConnectorInteractiveWorkflow when the connector's
    provider is registered in the provider catalog with `testConnection` as a
    supported action (e.g. ONTAP). Returns the standard
    ``{success, message, [code], [data]}`` envelope so it slots into the existing
    test-connection UX.

    Maps requests.SSLError to ``code='TLS_VERIFY_FAILED'`` so the GUI can suggest
    disabling verify_tls or supplying a CA bundle for self-signed clusters.
    """
    log_activity_start(input)

    config: Dict[str, Any] = input.get("connectorConfig", {}) or {}
    project_id = input.get("projectID") or input.get("projectId") or ""
    credential_id = input.get("credentialID") or input.get("credentialId") or ""
    config_service_url = input.get("configServiceURL") or input.get("configServiceUrl") or ""
    provider = (config.get("provider") or "").strip()

    if not provider:
        result = {"success": False, "message": "connectorConfig.provider is required"}
        log_activity_result(result)
        return result

    adapter = registry.get(provider)
    if not adapter:
        result = {
            "success": False,
            "message": f"No adapter registered for provider '{provider}'",
        }
        log_activity_result(result)
        return result

    activity.heartbeat("resolving-credential")
    try:
        credential = resolve_credential(config_service_url, project_id, credential_id)
    except Exception as e:
        logger.exception("TestProviderConnection: credential resolution failed")
        result = {
            "success": False,
            "message": f"Failed to resolve credential: {e}",
            "code": "CREDENTIAL_ERROR",
        }
        log_activity_result(result, error=e)
        return result

    activity.heartbeat("calling-adapter")
    try:
        resp = adapter.execute(config, credential, "testConnection", {})
    except requests.exceptions.SSLError as e:
        logger.error(
            "TestProviderConnection: TLS/SSL error for provider=%s: %s | "
            "REQUESTS_CA_BUNDLE=%s, SSL_CERT_FILE=%s",
            provider, e,
            os.environ.get("REQUESTS_CA_BUNDLE", "<unset>"),
            os.environ.get("SSL_CERT_FILE", "<unset>"),
        )
        result = {
            "success": False,
            "message": (
                f"TLS certificate verification failed for {provider}. "
                "Ensure the target endpoint's CA certificate is trusted by the connector worker. "
                "For ONTAP connectors, you can also set verify_tls=false or supply ca_bundle_pem in the credential."
            ),
            "code": "TLS_VERIFY_FAILED",
            "detail": str(e),
        }
        log_activity_result(result, error=e)
        return result
    except Exception as e:
        logger.exception("TestProviderConnection: adapter.execute failed")
        result = {"success": False, "message": str(e), "code": "PROVIDER_ERROR"}
        log_activity_result(result, error=e)
        return result

    envelope = resp.to_dict()
    if envelope.get("error"):
        err = envelope["error"]
        result = {
            "success": False,
            "message": err.get("message") or "Connection test failed",
            "code": err.get("code") or "PROVIDER_ERROR",
        }
        log_activity_result(result)
        return result

    nodes = envelope.get("nodes") or []
    summary = nodes[0] if nodes else {}
    cluster_name = summary.get("label") or provider
    version = (summary.get("metadata") or {}).get("version") if isinstance(summary, dict) else None
    msg = f"Connection successful to {cluster_name}"
    if version:
        msg = f"{msg} (version {version})"
    result = {"success": True, "message": msg, "data": envelope}
    log_activity_result(result)
    return result
