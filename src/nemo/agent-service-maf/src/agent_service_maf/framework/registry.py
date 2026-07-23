"""Framework registry — decorator-based discovery and instantiation of agent adapters.

The :class:`FrameworkRegistry` maintains a class-level mapping from framework name
strings to :class:`~agent_service_maf.framework.base_agent.BaseAgent` subclasses.
Registration happens at import time via the ``@FrameworkRegistry.register("name")``
decorator.

The registry also supports a :class:`LifecycleHook` interface for extensible
startup/shutdown without modifying the app lifespan block (OCP).

Usage:

.. code-block:: python

    from agent_service_maf.framework.registry import FrameworkRegistry

    @FrameworkRegistry.register("my_framework")
    class MyAdapter(BaseAgent):
        ...

    # Later, in executor or routes:
    agent = FrameworkRegistry.create("my_framework", config)
    await agent.initialize(context)
    response = await agent.invoke(request, context)
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Callable

import structlog
from fastapi import FastAPI

from agent_service_maf.core.exceptions import FrameworkNotFoundError
from agent_service_maf.core.interfaces import AgentCapabilities
from agent_service_maf.framework.base_agent import BaseAgent

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# LifecycleHook interface (OCP: extensible startup/shutdown)
# ---------------------------------------------------------------------------


class LifecycleHook(ABC):
    """Abstract interface for extensible application lifecycle hooks.

    Components that need to run code during app startup or shutdown should
    implement this interface and register with ``FrameworkRegistry.add_hook()``.

    This follows the Open/Closed Principle — new startup/shutdown behaviour can be
    added by registering hooks without modifying the ``lifespan()`` function in
    ``api.py``.

    Example:
        >>> class DatabaseHook(LifecycleHook):
        ...     async def on_startup(self, app):
        ...         app.state.db = await create_db_pool()
        ...     async def on_shutdown(self, app):
        ...         await app.state.db.close()
        >>> FrameworkRegistry.add_hook(DatabaseHook())
    """

    @abstractmethod
    async def on_startup(self, app: FastAPI) -> None:
        """Called during application startup before the first request.

        Args:
            app: The FastAPI application instance. Use ``app.state`` to store
                resources that routes need to access.

        Raises:
            Exception: Any exception raised here will abort startup. Ensure
                critical resources raise; non-critical resources log and continue.
        """
        ...

    @abstractmethod
    async def on_shutdown(self, app: FastAPI) -> None:
        """Called during application shutdown after the last request.

        Args:
            app: The FastAPI application instance. Access ``app.state`` to
                clean up resources stored during startup.

        Note:
            This method must not raise exceptions. Errors should be logged
            and swallowed to ensure all hooks run during shutdown.
        """
        ...


# ---------------------------------------------------------------------------
# FrameworkRegistryProtocol (DIP: inject abstraction, not concrete class)
# ---------------------------------------------------------------------------


class FrameworkRegistryProtocol(ABC):
    """Abstract protocol for framework registry operations.

    The :class:`~agent_service_maf.framework.executor.AgentExecutor` depends on
    this protocol rather than :class:`FrameworkRegistry` directly. This follows
    the Dependency Inversion Principle — high-level modules (executor) depend on
    abstractions, not concrete registries.

    Implementations: :class:`FrameworkRegistry`.
    Test doubles: ``MockRegistry`` in test fixtures.
    """

    @classmethod
    @abstractmethod
    def create(cls, name: str, config: object) -> BaseAgent:
        """Instantiate a registered adapter by name.

        Args:
            name: The framework identifier (e.g., ``"maf"``).
            config: Configuration object passed to the adapter constructor.

        Returns:
            An initialized :class:`~agent_service_maf.framework.base_agent.BaseAgent`
            instance (not yet ``initialize()``-d).

        Raises:
            FrameworkNotFoundError: If ``name`` is not registered.
        """
        ...

    @classmethod
    @abstractmethod
    def list_frameworks(cls) -> list[str]:
        """List all registered framework names.

        Returns:
            List of registered framework name strings.
        """
        ...

    @classmethod
    @abstractmethod
    def list_capabilities(cls) -> list[AgentCapabilities]:
        """Get capabilities from all registered adapters.

        Returns:
            List of :class:`~agent_service_maf.core.interfaces.AgentCapabilities`
            descriptors for all registered adapters.
        """
        ...

    @classmethod
    @abstractmethod
    def is_registered(cls, name: str) -> bool:
        """Check whether a framework name is registered.

        Args:
            name: The framework identifier to check.

        Returns:
            ``True`` if the framework is registered, ``False`` otherwise.
        """
        ...


# ---------------------------------------------------------------------------
# FrameworkRegistry
# ---------------------------------------------------------------------------


class FrameworkRegistry(FrameworkRegistryProtocol):
    """Class-level registry for pluggable agent framework adapters.

    Adapters self-register at import time via the ``@FrameworkRegistry.register("name")``
    decorator. The registry is a class variable shared across all instances, so there is
    no need to pass a registry instance around — use the class methods directly.

    Class Attributes:
        _adapters: Mapping from framework name to adapter class.
        _hooks: List of :class:`LifecycleHook` instances to call on startup/shutdown.

    Example:
        >>> @FrameworkRegistry.register("echo")
        ... class EchoAgent(BaseAgent):
        ...     ...
        >>> FrameworkRegistry.is_registered("echo")
        True
        >>> agent = FrameworkRegistry.create("echo", config)
    """

    _adapters: dict[str, type[BaseAgent]] = {}
    _hooks: list[LifecycleHook] = []

    @classmethod
    def register(cls, name: str) -> Callable[[type[BaseAgent]], type[BaseAgent]]:
        """Class decorator that registers an adapter under the given name.

        Registration is idempotent — re-registering the same class under the same
        name is a no-op. Re-registering a different class logs a warning and
        replaces the previous registration.

        Args:
            name: Framework identifier. Must match ``^[a-zA-Z0-9_-]{1,64}$``.
                This name is used in ``agent.framework`` config and in API paths.

        Returns:
            A decorator function that returns the adapter class unchanged.

        Raises:
            ValueError: If ``name`` is empty or exceeds 64 characters.

        Example:
            >>> @FrameworkRegistry.register("maf")
            ... class AgentFrameworkAdapter(BaseAgent):
            ...     ...
        """
        if not name or not re.match(r"^[a-zA-Z0-9_-]{1,64}$", name):
            raise ValueError(
                f"Invalid framework name '{name}': must match ^[a-zA-Z0-9_-]{{1,64}}$. "
                "Use lowercase letters, numbers, hyphens, or underscores, max 64 chars."
            )

        def decorator(agent_cls: type[BaseAgent]) -> type[BaseAgent]:
            if name in cls._adapters and cls._adapters[name] is not agent_cls:
                logger.warning(
                    "Overwriting registered adapter",
                    name=name,
                    previous=cls._adapters[name].__name__,
                    new=agent_cls.__name__,
                )
            cls._adapters[name] = agent_cls
            logger.info(
                "Registered framework adapter",
                name=name,
                cls=agent_cls.__name__,
            )
            return agent_cls

        return decorator

    @classmethod
    def create(cls, name: str, config: object) -> BaseAgent:
        """Instantiate a registered adapter by name.

        Args:
            name: Framework identifier (e.g., ``"maf"``, ``"echo"``).
            config: Configuration object passed to the adapter's ``__init__``.
                Typically an ``AgentConfig`` instance.

        Returns:
            An uninitialized :class:`~agent_service_maf.framework.base_agent.BaseAgent`
            instance. The caller must call ``await agent.initialize(context)`` before
            invoking.

        Raises:
            FrameworkNotFoundError: If ``name`` is not registered. The message
                includes all available framework names and instructions for fixing.

        Example:
            >>> agent = FrameworkRegistry.create("echo", config)
            >>> await agent.initialize(context)
            >>> response = await agent.invoke(request, context)
        """
        if name not in cls._adapters:
            available = sorted(cls._adapters.keys())
            raise FrameworkNotFoundError(
                f"Framework '{name}' is not registered. "
                f"Available frameworks: {available if available else '(none registered)'}. "
                f"Ensure the adapter module is imported in framework/__init__.py and "
                f"is decorated with @FrameworkRegistry.register('{name}').",
                details={"requested": name, "available": available},
            )
        return cls._adapters[name](config)

    @classmethod
    def list_frameworks(cls) -> list[str]:
        """List all registered framework names in alphabetical order.

        Returns:
            Sorted list of registered framework name strings.

        Example:
            >>> FrameworkRegistry.list_frameworks()
            ['echo', 'maf']
        """
        return sorted(cls._adapters.keys())

    @classmethod
    def list_capabilities(cls) -> list[AgentCapabilities]:
        """Get capabilities from all registered adapters.

        Instantiates each adapter class (without config or context) and calls
        ``get_capabilities()``. Adapters that raise during this call return a
        placeholder capability descriptor.

        Returns:
            List of :class:`~agent_service_maf.core.interfaces.AgentCapabilities`
            instances, one per registered adapter.

        Example:
            >>> caps = FrameworkRegistry.list_capabilities()
            >>> [c.agent_id for c in caps]
            ['echo', 'maf']
        """
        capabilities: list[AgentCapabilities] = []
        for name, adapter_cls in cls._adapters.items():
            try:
                instance = adapter_cls.__new__(adapter_cls)
                caps = instance.get_capabilities()
                capabilities.append(caps)
            except Exception as exc:
                logger.warning(
                    "Failed to get capabilities for adapter",
                    name=name,
                    error=str(exc),
                )
                capabilities.append(
                    AgentCapabilities(
                        agent_id=name,
                        framework=name,
                        description=(
                            "(capabilities unavailable — adapter raised during introspection)"
                        ),
                    )
                )
        return capabilities

    @classmethod
    def is_registered(cls, name: str) -> bool:
        """Check whether a framework name is registered.

        Args:
            name: The framework identifier to check.

        Returns:
            ``True`` if the framework is registered, ``False`` otherwise.

        Example:
            >>> FrameworkRegistry.is_registered("maf")
            True
            >>> FrameworkRegistry.is_registered("nonexistent")
            False
        """
        return name in cls._adapters

    @classmethod
    def add_hook(cls, hook: LifecycleHook) -> None:
        """Register a lifecycle hook to be called on startup and shutdown.

        Args:
            hook: A :class:`LifecycleHook` instance. Will be called in registration
                order during startup, and in reverse order during shutdown.

        Example:
            >>> FrameworkRegistry.add_hook(DatabaseHook())
        """
        cls._hooks.append(hook)
        logger.info("Registered lifecycle hook", hook=type(hook).__name__)

    @classmethod
    async def run_startup_hooks(cls, app: FastAPI) -> None:
        """Execute all registered startup hooks in registration order.

        Called by the FastAPI lifespan context manager during startup.

        Args:
            app: The FastAPI application instance passed to each hook's
                ``on_startup()`` method.

        Raises:
            Exception: If any hook's ``on_startup()`` raises, the exception
                propagates and aborts startup.

        Example:
            >>> await FrameworkRegistry.run_startup_hooks(app)
        """
        for hook in cls._hooks:
            logger.info("Running startup hook", hook=type(hook).__name__)
            await hook.on_startup(app)

    @classmethod
    async def run_shutdown_hooks(cls, app: FastAPI) -> None:
        """Execute all registered shutdown hooks in reverse registration order.

        Called by the FastAPI lifespan context manager during shutdown. Errors
        are caught and logged so that all hooks always run.

        Args:
            app: The FastAPI application instance passed to each hook's
                ``on_shutdown()`` method.

        Example:
            >>> await FrameworkRegistry.run_shutdown_hooks(app)
        """
        for hook in reversed(cls._hooks):
            try:
                logger.info("Running shutdown hook", hook=type(hook).__name__)
                await hook.on_shutdown(app)
            except Exception as exc:
                logger.error(
                    "Shutdown hook failed",
                    hook=type(hook).__name__,
                    error=str(exc),
                )

    @classmethod
    def clear(cls) -> None:
        """Clear all registered adapters and hooks. For testing only.

        Resets the registry to an empty state. This is useful in unit tests that
        register temporary adapters without polluting the global registry state.

        Example:
            >>> FrameworkRegistry.clear()
            >>> FrameworkRegistry.list_frameworks()
            []
        """
        cls._adapters.clear()
        cls._hooks.clear()
