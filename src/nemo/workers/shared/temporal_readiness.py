"""Shared Temporal-readiness helpers for the AgentStudio Python workers.

The default `wait-for-temporal` init container only checks TCP reachability
of the Temporal gRPC endpoint. TCP-accept happens long before Temporal's
matching / namespace / visibility services are actually ready to serve.
A worker that starts in that window races: `Client.connect()` succeeds
(the gRPC channel comes up), but the Rust core's heartbeat-capabilities
probe (`DescribeNamespace`) fails with `Timeout expired`. From that
point on the worker stays dead-alive — the Python coroutine waits inside
`async with worker:` forever while the underlying poller never comes
online. Symptom on the dispatch side: every activity hits
`ScheduleToStart timeout` because zero pollers are registered. Verified
on sks6316.

This module fixes both sides of that race:

  * `wait_for_temporal(...)` retries `Client.connect` + `DescribeNamespace`
    until both succeed. Use it at worker startup instead of the bare
    `Client.connect`. Pair it with a deeper gRPC init-container probe so
    the worker process itself rarely sees the transient state.

  * `start_watchdog(client, namespace)` spawns a background asyncio task
    that periodically re-runs `DescribeNamespace`. After N consecutive
    failures it calls `os._exit(1)`, letting K8s restart the pod rather
    than leaving a dead-alive worker. Catches Temporal restarts that
    happen mid-life (e.g., a `force-pull-rollout-local` on the platform
    tier).

Both helpers are SDK-version-agnostic against `temporalio>=1.7.0`.
"""

from __future__ import annotations

import asyncio
import os
from observability_client_runtime import get_logger
from typing import Optional

import temporalio.api.workflowservice.v1 as wsv1
from temporalio.client import Client

logger = get_logger()


async def wait_for_temporal(
    address: str,
    namespace: str,
    *,
    max_attempts: int = 60,
    retry_interval_seconds: float = 2.0,
) -> Client:
    """Connect to Temporal and wait until `DescribeNamespace` succeeds.

    `Client.connect` returns as soon as the gRPC channel is up — that
    can be true before Temporal's frontend has loaded the namespace,
    which is exactly when the Rust core's heartbeat probe later fails
    and wedges the worker. By gating worker construction on a real
    `DescribeNamespace` round-trip, the SDK's later heartbeat is
    guaranteed to find a ready namespace.

    Args:
        address: Temporal frontend `host:port`.
        namespace: namespace to probe (must match the worker's namespace).
        max_attempts: total tries before giving up. With 2s interval the
            default 60 attempts ≈ 2 minutes — long enough to cover a
            fresh Temporal pod warm-up after my hardened
            `force-pull-rollout-local` rolls platform.
        retry_interval_seconds: sleep between attempts.

    Returns:
        A connected `Client` whose namespace describe has succeeded at
        least once.

    Raises:
        RuntimeError: namespace never became describable within budget.
    """
    last_err: Optional[BaseException] = None
    for attempt in range(1, max_attempts + 1):
        try:
            client = await Client.connect(address, namespace=namespace)
            await client.workflow_service.describe_namespace(
                wsv1.DescribeNamespaceRequest(namespace=namespace)
            )
            if attempt > 1:
                logger.info(
                    "Temporal namespace %r became ready after %d attempts (%s)",
                    namespace,
                    attempt,
                    address,
                )
            else:
                logger.info(
                    "Temporal namespace %r ready on first attempt (%s)",
                    namespace,
                    address,
                )
            return client
        except Exception as exc:
            last_err = exc
            logger.warning(
                "Temporal not ready (attempt %d/%d at %s, ns=%s): %s",
                attempt,
                max_attempts,
                address,
                namespace,
                exc,
            )
            await asyncio.sleep(retry_interval_seconds)
    raise RuntimeError(
        f"Temporal namespace {namespace!r} at {address} never became "
        f"describable after {max_attempts} attempts "
        f"({max_attempts * retry_interval_seconds:.0f}s). "
        f"Last error: {last_err!r}"
    )


def start_watchdog(
    client: Client,
    namespace: str,
    *,
    check_interval_seconds: float = 60.0,
    failures_before_exit: int = 3,
) -> "asyncio.Task[None]":
    """Spawn a background liveness probe; crash the process on persistent failure.

    Even with `wait_for_temporal` at startup, transient Temporal
    disruptions during normal operation can leave the worker's poller
    silently offline (the SDK's heartbeat thread doesn't always
    self-recover). The watchdog re-runs `DescribeNamespace` on a fixed
    interval and `os._exit(1)`s after `failures_before_exit` consecutive
    failures — letting Kubernetes restart the pod rather than leaving a
    dead-alive worker that Temporal sees zero pollers for.

    Tolerates `failures_before_exit - 1` transient blips so a brief
    network hiccup doesn't churn the pod. `os._exit` (not `sys.exit`)
    bypasses asyncio shutdown machinery — important because the symptom
    we're escaping is precisely that the worker won't shut down
    gracefully.

    Args:
        client: connected Temporal client (from `wait_for_temporal`).
        namespace: same namespace passed to `wait_for_temporal`.
        check_interval_seconds: between probes.
        failures_before_exit: consecutive failures that trigger exit.

    Returns:
        The spawned `asyncio.Task` so the caller can cancel it on a
        clean shutdown (not strictly required — process exit cleans up).
    """

    async def _watchdog() -> None:
        consecutive_failures = 0
        while True:
            await asyncio.sleep(check_interval_seconds)
            try:
                await client.workflow_service.describe_namespace(
                    wsv1.DescribeNamespaceRequest(namespace=namespace)
                )
                if consecutive_failures > 0:
                    logger.info(
                        "Temporal watchdog: namespace %r healthy again after %d failure(s)",
                        namespace,
                        consecutive_failures,
                    )
                consecutive_failures = 0
            except Exception as exc:
                consecutive_failures += 1
                logger.warning(
                    "Temporal watchdog: describe_namespace(%r) failed (%d/%d): %s",
                    namespace,
                    consecutive_failures,
                    failures_before_exit,
                    exc,
                )
                if consecutive_failures >= failures_before_exit:
                    logger.error(
                        "Temporal watchdog: namespace %r unreachable for %d "
                        "consecutive probes — exiting so K8s restarts us.",
                        namespace,
                        consecutive_failures,
                    )
                    # _exit, not sys.exit: skip asyncio teardown, which is
                    # exactly the path that gets wedged when the poller is
                    # already offline.
                    os._exit(1)

    return asyncio.create_task(_watchdog(), name="temporal-watchdog")


# CLI entrypoint used by the wait-for-temporal init container.
#
# Container runs `python -m shared.temporal_readiness probe` and exits 0
# once the namespace describes successfully, 1 if it never does.
def _cli_probe() -> int:
    """Init-container entry point: probe Temporal until the namespace is
    describable, then exit 0.

    Env:
        TEMPORAL_ADDRESS  (default: temporal.agentstudio-platform.svc.cluster.local:7233)
        TEMPORAL_NAMESPACE (default: default)
        TEMPORAL_PROBE_MAX_ATTEMPTS (default: 90, ~3 minutes at 2s interval)

    Designed to replace `nc -z` as the worker init container probe.
    """
    addr = os.environ.get(
        "TEMPORAL_ADDRESS",
        "temporal.agentstudio-platform.svc.cluster.local:7233",
    )
    ns = os.environ.get("TEMPORAL_NAMESPACE", "default")
    max_attempts = int(os.environ.get("TEMPORAL_PROBE_MAX_ATTEMPTS", "90"))
    try:
        asyncio.run(
            wait_for_temporal(addr, ns, max_attempts=max_attempts)
        )
        return 0
    except Exception as exc:
        logger.error("Temporal readiness probe failed: %s", exc)
        return 1


if __name__ == "__main__":
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "probe":
        sys.exit(_cli_probe())
    print("Usage: python -m shared.temporal_readiness probe", file=sys.stderr)
    sys.exit(2)
