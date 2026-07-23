"""Poll long-running platform resources until terminal state."""

from __future__ import annotations

import time
from typing import Any, Callable

import httpx


def _acquisition_facet_state(dataset: dict[str, Any]) -> str:
    facets = dataset.get("facets") or []
    for facet in facets:
        if facet.get("facetType") == "acquisition":
            return str(facet.get("state") or "none")
    return "none"


def wait_for_dataset_ready(
    get_dataset: Callable[[], httpx.Response],
    *,
    timeout_sec: int,
    poll_interval_sec: int,
) -> dict[str, Any]:
    deadline = time.time() + timeout_sec
    last_status = ""
    last_acq = ""
    while time.time() < deadline:
        resp = get_dataset()
        if resp.status_code != 200:
            raise AssertionError(f"poll dataset: HTTP {resp.status_code}: {resp.text}")
        body = resp.json()
        last_status = str(body.get("status") or "")
        last_acq = _acquisition_facet_state(body)
        if last_status == "ready":
            if last_acq in ("errored", "failed"):
                raise AssertionError(
                    f"dataset ready but acquisition facet={last_acq}: {body}"
                )
            return body
        if last_status == "errored":
            raise AssertionError(f"dataset errored (acquisition={last_acq}): {body}")
        time.sleep(poll_interval_sec)
    raise TimeoutError(
        f"dataset not ready after {timeout_sec}s "
        f"(last status={last_status}, acquisition={last_acq})"
    )


def wait_for_kb_ready(
    get_kb: Callable[[], httpx.Response],
    *,
    timeout_sec: int,
    poll_interval_sec: int,
) -> dict[str, Any]:
    deadline = time.time() + timeout_sec
    last_status = ""
    while time.time() < deadline:
        resp = get_kb()
        if resp.status_code != 200:
            raise AssertionError(f"poll knowledge base: HTTP {resp.status_code}: {resp.text}")
        body = resp.json()
        last_status = str(body.get("status") or "")
        if last_status == "ready":
            return body
        if last_status == "errored":
            err = body.get("errorMessage") or body
            raise AssertionError(f"knowledge base errored: {err}")
        time.sleep(poll_interval_sec)
    raise TimeoutError(f"knowledge base not ready after {timeout_sec}s (last={last_status})")


def wait_for_project_scoped_access(
    probe: Callable[[], httpx.Response],
    *,
    timeout_sec: int,
    poll_interval_sec: int = 5,
) -> None:
    """
    Poll until project-scoped config APIs respond.

    After POST /projects the project-init workflow must register the Keycloak
    ``project:{id}`` resource before the edge UMA filter allows
    ``/projects/{id}/*`` calls. Until then Istio returns 502 with an empty body.
    """
    deadline = time.time() + timeout_sec
    last_status = 0
    last_body = ""
    while time.time() < deadline:
        resp = probe()
        last_status = resp.status_code
        last_body = resp.text[:200]
        if resp.status_code == 200:
            return
        if resp.status_code in (409, 502, 503):
            time.sleep(poll_interval_sec)
            continue
        raise AssertionError(
            f"project-scoped API probe failed: HTTP {resp.status_code} {resp.text[:500]}"
        )
    raise TimeoutError(
        f"project not ready for scoped API calls after {timeout_sec}s "
        f"(last HTTP {last_status}: {last_body!r}). "
        "Ensure bifrost-proxy is running and project-init workflow completed."
    )


def wait_for_project_ready(
    get_models: Callable[[], httpx.Response],
    *,
    get_service_account: Callable[[], httpx.Response] | None = None,
    timeout_sec: int,
    poll_interval_sec: int = 5,
    min_models: int = 1,
) -> list[dict[str, Any]]:
    """Poll until project-init has seeded models and (optionally) the Keycloak SA.

    `POST /projects` returns 201 immediately but fires async project-init.
    Built-in TEI models appear after gateway-setup (step 4); create-shaped
    routes such as ``POST .../models`` also require the per-project Keycloak
    service account (step 8). Polling models alone can therefore pass while
    model registration still returns 409 on slower environments (e.g. GKE).
    Pass ``get_service_account`` (``GET .../service-account`` → 200) to gate
    on the full identity-setup step.
    """
    deadline = time.time() + timeout_sec
    last = ""
    while time.time() < deadline:
        resp = get_models()
        if resp.status_code == 200:
            body = resp.json()
            models = body if isinstance(body, list) else body.get("models") or []
            if len(models) >= min_models:
                if get_service_account is None:
                    return models
                sa_resp = get_service_account()
                if sa_resp.status_code == 200:
                    return models
                last = (
                    f"models ready ({len(models)}), "
                    f"service-account HTTP {sa_resp.status_code}: {sa_resp.text[:120]}"
                )
            else:
                last = f"200 with {len(models)} models"
        else:
            last = f"HTTP {resp.status_code}: {resp.text[:200]}"
        time.sleep(poll_interval_sec)
    detail = "built-in models not seeded"
    if get_service_account is not None:
        detail = "project-init not complete (models + Keycloak service account)"
    raise TimeoutError(f"project not ready ({detail}) after {timeout_sec}s (last={last})")


def wait_for_platform_project_ready(
    platform_client: Any,
    project_id: str,
    *,
    timeout_sec: int,
    poll_interval_sec: int = 5,
    min_models: int = 1,
) -> list[dict[str, Any]]:
    """Convenience wrapper: models list + service-account readiness for PlatformClient."""
    prefix = platform_client.project_prefix(project_id)
    return wait_for_project_ready(
        lambda: platform_client.config_get(f"{prefix}/models"),
        get_service_account=lambda: platform_client.get_project_service_account(project_id),
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
        min_models=min_models,
    )


def wait_for_workflow_terminal(
    get_status: Callable[[], httpx.Response],
    *,
    timeout_sec: int,
    poll_interval_sec: int = 2,
) -> dict[str, Any]:
    """Poll workflow-engine GET …/workflows/:id/status until completed or failed."""
    deadline = time.time() + timeout_sec
    last_status = ""
    while time.time() < deadline:
        resp = get_status()
        if resp.status_code == 404:
            time.sleep(poll_interval_sec)
            continue
        if resp.status_code != 200:
            raise AssertionError(f"poll workflow: HTTP {resp.status_code}: {resp.text}")
        body = resp.json()
        last_status = str(body.get("status") or "")
        if last_status == "completed":
            return body
        if last_status in ("failed", "cancelled", "terminated", "timed_out"):
            msg = body.get("failureMessage") or last_status
            raise AssertionError(f"workflow {last_status}: {msg}")
        if not body.get("isRunning", True):
            raise AssertionError(f"workflow ended unexpectedly: {body}")
        time.sleep(poll_interval_sec)
    raise TimeoutError(
        f"workflow not terminal after {timeout_sec}s (last status={last_status})"
    )


def wait_for_mcp_runtime_ready(
    get_runtime_status: Callable[[], httpx.Response],
    *,
    timeout_sec: int,
    poll_interval_sec: int = 5,
) -> dict[str, Any]:
    """Poll managed MCP server runtime-status until running and pod-ready."""
    deadline = time.time() + timeout_sec
    last_status = ""
    last_phase = ""
    while time.time() < deadline:
        resp = get_runtime_status()
        if resp.status_code != 200:
            raise AssertionError(
                f"poll mcp runtime-status: HTTP {resp.status_code}: {resp.text}"
            )
        body = resp.json()
        last_status = str(body.get("runtimeStatus") or "")
        last_phase = str(body.get("phase") or "")
        ready = bool(body.get("ready"))
        if last_status == "running" and ready:
            return body
        if last_status == "failed":
            raise AssertionError(
                f"mcp server runtime failed (phase={last_phase}): {body}"
            )
        time.sleep(poll_interval_sec)
    raise TimeoutError(
        f"mcp server not ready after {timeout_sec}s "
        f"(last runtimeStatus={last_status}, phase={last_phase})"
    )


def wait_for_mcp_gateway_synced(
    get_mcp_server: Callable[[], httpx.Response],
    *,
    timeout_sec: int,
    poll_interval_sec: int = 5,
) -> dict[str, Any]:
    """Poll GET .../mcp-servers/:id until Bifrost registration completes.

    Managed MCP provisioning marks the pod running before config-service
    registers the server with Bifrost (``llmproxyGatewayServerName`` /
    ``syncStatus: synced``). Test-connection and list-tools require that sync.
    """
    deadline = time.time() + timeout_sec
    last = ""
    while time.time() < deadline:
        resp = get_mcp_server()
        if resp.status_code != 200:
            raise AssertionError(
                f"poll mcp server: HTTP {resp.status_code}: {resp.text}"
            )
        body = resp.json()
        sync_status = str(body.get("syncStatus") or "")
        gateway_name = body.get("llmproxyGatewayServerName")
        if sync_status == "error":
            raise AssertionError(f"mcp server Bifrost sync failed: {body}")
        if sync_status == "synced" and gateway_name:
            return body
        last = f"syncStatus={sync_status!r}, llmproxyGatewayServerName={gateway_name!r}"
        time.sleep(poll_interval_sec)
    raise TimeoutError(
        f"mcp server not synced to Bifrost after {timeout_sec}s (last={last})"
    )
