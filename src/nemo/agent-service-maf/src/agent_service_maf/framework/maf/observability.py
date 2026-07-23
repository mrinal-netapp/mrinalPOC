"""Observability wiring for the Microsoft Agent Framework adapter.

Agent Framework ships first-class OpenTelemetry instrumentation: the agent /
chat-client telemetry layers (already part of
:class:`~agent_service_maf.framework.maf.gateway_chat_client.BifrostChatClient`'s
layer stack) emit ``gen_ai.*`` spans + metrics once instrumentation is turned on.
Calling :func:`agent_framework.observability.enable_instrumentation` activates
those layers; spans then flow to whatever global OpenTelemetry ``TracerProvider``
the host process has configured (the service's existing exporter), so no new
exporter is created here.

This is driven by the ``semantic_kernel.enable_telemetry`` config knob (key
name retained for back-compat): when it is set, :func:`enable_af_observability`
is invoked once at adapter initialization.

Activation is **process-wide and idempotent** -- AF's instrumentation patches
global state, so we guard against re-enabling it across adapter instances /
requests with a module-level flag behind a lock.
"""

from __future__ import annotations

import threading

import structlog

logger = structlog.get_logger(__name__)

_lock = threading.Lock()
_enabled = False


def enable_af_observability(*, enable_sensitive_data: bool = False) -> bool:
    """Enable Agent Framework OpenTelemetry instrumentation (idempotent).

    Args:
        enable_sensitive_data: When ``True``, AF includes prompt / completion
            content on spans. Defaults to ``False`` so message bodies are not
            exported. Mirrors AF's ``enable_sensitive_data`` flag.

    Returns:
        ``True`` if instrumentation was activated by this call, ``False`` if it
        was already active or the framework's observability module is
        unavailable (in which case the failure is logged, not raised -- telemetry
        must never break agent execution).
    """
    global _enabled
    with _lock:
        if _enabled:
            return False
        try:
            from agent_framework.observability import enable_instrumentation
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Agent Framework observability unavailable; telemetry disabled",
                error=str(exc),
            )
            return False

        try:
            enable_instrumentation(enable_sensitive_data=enable_sensitive_data)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Failed to enable Agent Framework instrumentation; telemetry disabled",
                error=str(exc),
            )
            return False

        _enabled = True
        logger.info(
            "Agent Framework observability enabled",
            enable_sensitive_data=enable_sensitive_data,
        )
        return True


def reset_af_observability_for_tests() -> None:
    """Reset the module-level activation flag. For tests only."""
    global _enabled
    with _lock:
        _enabled = False
