"""Pluggable agent framework layer — adapters, registry, and executor.

This package provides:
- :class:`~agent_service_maf.framework.base_agent.BaseAgent`: Abstract base for adapters.
- :class:`~agent_service_maf.framework.registry.FrameworkRegistry`: Decorator-based registry.
- :class:`~agent_service_maf.framework.registry.LifecycleHook`: Extensible startup/shutdown.
- :class:`~agent_service_maf.framework.executor.AgentExecutor`: High-level executor.
- :mod:`~agent_service_maf.framework.maf`: Microsoft Agent Framework adapter package
  (the production framework, registered as ``"maf"``).
"""

# Import adapters to trigger @FrameworkRegistry.register() decorators. The
# Microsoft Agent Framework adapter (``maf``) is the production framework and is
# imported unconditionally; its dependencies ship via the ``agent-framework``
# extra and are required for the service to run.
import agent_service_maf.framework.echo_adapter  # noqa: F401
import agent_service_maf.framework.maf.adapter  # noqa: F401
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.executor import AgentExecutor
from agent_service_maf.framework.registry import FrameworkRegistry, LifecycleHook

__all__ = [
    "BaseAgent",
    "FrameworkRegistry",
    "LifecycleHook",
    "AgentExecutor",
]
