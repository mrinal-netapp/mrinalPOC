"""Poll config-service resources until they reach a ready or terminal state."""

from __future__ import annotations

import time

from lib.config_service.client import ConfigServiceClient

TERMINAL_EVAL_RUN_STATUSES = frozenset({"success", "failed", "cancelled"})


def wait_for_project_ready(
    client: ConfigServiceClient,
    project_id: str,
    *,
    timeout_sec: int = 60,
    poll_interval_sec: int = 5,
) -> None:
    """Poll ``GET /projects/{id}/service-account`` until identity setup is done.

    Function use:
        ``POST /projects`` returns ``201`` immediately, but the project-init
        workflow provisions the Bifrost gateway then the per-project Keycloak
        client asynchronously. Create-shaped calls (e.g. add-model) 409 until
        that finishes. The service-account endpoint returns ``200`` once the
        Keycloak client (the last init step) exists, and ``404`` while still
        provisioning — so a ``200`` means the project is ready to use.

    Input:
        client (ConfigServiceClient): The config-service client.
        project_id (str): The config-service project identifier.
        timeout_sec (int): Max seconds to wait for readiness.
        poll_interval_sec (int): Seconds between polls.

    Output:
        None. Returns once ready; raises ``TimeoutError`` on timeout.
    """
    deadline = time.time() + timeout_sec
    last = ""
    while time.time() < deadline:
        resp = client.get_project_service_account(project_id)
        if resp.status_code == 200:
            return
        last = f"HTTP {resp.status_code}: {resp.text}"
        time.sleep(poll_interval_sec)
    raise TimeoutError(
        f"project {project_id} not ready after {timeout_sec}s (last: {last})"
    )


def wait_for_evaluation_run_terminal(
    client: ConfigServiceClient,
    project_id: str,
    run_id: str,
    *,
    timeout_sec: int = 300,
    poll_interval_sec: int = 10,
) -> tuple[dict, list[str]]:
    """Poll ``GET /runs/{runId}`` until the run reaches a terminal status.

    Returns the final run payload and the distinct statuses observed in order.
    Raises ``TimeoutError`` when the deadline is reached without a terminal
    status.
    """
    deadline = time.time() + timeout_sec
    observed_statuses: list[str] = []
    last_status = ""
    last_body = ""
    while time.time() < deadline:
        resp = client.get_evaluation_run(project_id, run_id)
        if resp.status_code != 200:
            last_body = f"HTTP {resp.status_code}: {resp.text}"
            time.sleep(poll_interval_sec)
            continue
        run = resp.json()
        status = run.get("status", "")
        if status and (not observed_statuses or observed_statuses[-1] != status):
            observed_statuses.append(status)
        last_status = status
        if status in TERMINAL_EVAL_RUN_STATUSES:
            return run, observed_statuses
        time.sleep(poll_interval_sec)
    raise TimeoutError(
        f"evaluation run {run_id} not terminal after {timeout_sec}s "
        f"(last status={last_status!r}, observed={observed_statuses}, last: {last_body})"
    )
