"""Guardrail registry — discover and instantiate guardrails by name.

:class:`GuardrailRegistry` is an Open/Closed registry: new guardrails are registered
via decorators without modifying the registry itself.

Registration happens at import time:

.. code-block:: python

    @GuardrailRegistry.register_input("prompt_injection")
    class PromptInjectionDetector(InputGuardrail): ...

The :meth:`GuardrailRegistry.build_pipeline` method constructs a
:class:`~agent_service_maf.guardrails.pipeline.GuardrailPipeline` from a
:class:`~agent_service_maf.config.validators.GuardrailSection` config object,
resolving per-agent overrides and skipping disabled guardrails.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, TypeVar, cast

import structlog

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.guardrails.base import InputGuardrail, OutputGuardrail, ToolGuardrail
from agent_service_maf.guardrails.pipeline import GuardrailPipeline

if TYPE_CHECKING:
    from agent_service_maf.config.validators import GuardrailRule, GuardrailSection, ToolPolicy

_TInput = TypeVar("_TInput", bound=type[InputGuardrail])
_TOutput = TypeVar("_TOutput", bound=type[OutputGuardrail])
_TTool = TypeVar("_TTool", bound=type[ToolGuardrail])
_AnyGuardrail = InputGuardrail | OutputGuardrail | ToolGuardrail

logger = structlog.get_logger(__name__)


class GuardrailRegistry:
    """Registry mapping guardrail names to classes with decorator-based registration.

    Follows the Open/Closed Principle: new guardrails extend the registry via
    ``@register_input``, ``@register_output``, or ``@register_tool`` decorators
    without modifying this class.

    Class Attributes:
        _input_guardrails: Map of name → ``InputGuardrail`` class.
        _output_guardrails: Map of name → ``OutputGuardrail`` class.
        _tool_guardrails: Map of name → ``ToolGuardrail`` class.

    Example:
        >>> @GuardrailRegistry.register_input("my_guardrail")
        ... class MyGuardrail(InputGuardrail):
        ...     name = "my_guardrail"
        ...     async def check(self, ctx): ...
        ...
        >>> pipeline = GuardrailRegistry.build_pipeline(config, agent_id="my-agent")
    """

    _input_guardrails: dict[str, type[InputGuardrail]] = {}
    _output_guardrails: dict[str, type[OutputGuardrail]] = {}
    _tool_guardrails: dict[str, type[ToolGuardrail]] = {}

    # ------------------------------------------------------------------
    # Decorator registration
    # ------------------------------------------------------------------

    @classmethod
    def register_input(cls, name: str) -> Callable[[_TInput], _TInput]:
        """Decorator that registers an InputGuardrail class.

        Args:
            name: The string key used to reference this guardrail in config.
                Must be unique across all input guardrails.

        Returns:
            A class decorator that registers the guardrail and returns it unchanged.

        Raises:
            ValueError: If ``name`` is empty.

        Example:
            >>> @GuardrailRegistry.register_input("my_input_guard")
            ... class MyInputGuard(InputGuardrail):
            ...     name = "my_input_guard"
            ...     async def check(self, ctx): ...
        """
        if not name:
            raise ValueError(
                "Guardrail name must be a non-empty string. "
                "Provide a unique snake_case identifier like 'my_input_guard'."
            )

        def decorator(klass: _TInput) -> _TInput:
            cls._input_guardrails[name] = klass
            logger.debug("Registered input guardrail", name=name, class_name=klass.__name__)
            return klass

        return decorator

    @classmethod
    def register_output(cls, name: str) -> Callable[[_TOutput], _TOutput]:
        """Decorator that registers an OutputGuardrail class.

        Args:
            name: The string key used to reference this guardrail in config.

        Returns:
            A class decorator that registers the guardrail and returns it unchanged.

        Raises:
            ValueError: If ``name`` is empty.

        Example:
            >>> @GuardrailRegistry.register_output("my_output_guard")
            ... class MyOutputGuard(OutputGuardrail):
            ...     name = "my_output_guard"
            ...     async def check(self, ctx): ...
        """
        if not name:
            raise ValueError(
                "Guardrail name must be a non-empty string. "
                "Provide a unique snake_case identifier like 'my_output_guard'."
            )

        def decorator(klass: _TOutput) -> _TOutput:
            cls._output_guardrails[name] = klass
            logger.debug("Registered output guardrail", name=name, class_name=klass.__name__)
            return klass

        return decorator

    @classmethod
    def register_tool(cls, name: str) -> Callable[[_TTool], _TTool]:
        """Decorator that registers a ToolGuardrail class.

        Args:
            name: The string key used to reference this guardrail in config.

        Returns:
            A class decorator that registers the guardrail and returns it unchanged.

        Raises:
            ValueError: If ``name`` is empty.

        Example:
            >>> @GuardrailRegistry.register_tool("my_tool_guard")
            ... class MyToolGuard(ToolGuardrail):
            ...     name = "my_tool_guard"
            ...     async def check(self, ctx): ...
        """
        if not name:
            raise ValueError(
                "Guardrail name must be a non-empty string. "
                "Provide a unique snake_case identifier like 'my_tool_guard'."
            )

        def decorator(klass: _TTool) -> _TTool:
            cls._tool_guardrails[name] = klass
            logger.debug("Registered tool guardrail", name=name, class_name=klass.__name__)
            return klass

        return decorator

    # ------------------------------------------------------------------
    # Pipeline building
    # ------------------------------------------------------------------

    @classmethod
    def build_pipeline(
        cls,
        config: GuardrailSection,
        agent_id: str = "",
    ) -> GuardrailPipeline:
        """Build a :class:`~agent_service_maf.guardrails.pipeline.GuardrailPipeline` from config.

        Algorithm:
        1. Start with ``config.input_guardrails`` and
           ``config.output_guardrails`` and ``config.tool_guardrails``.
        2. If ``agent_id`` has an entry in ``config.agent_overrides``, merge:
           - The override's ``input_guardrails`` replaces the defaults.
           - The override's ``output_guardrails`` replaces the defaults.
           - The override's ``tool_policy`` replaces the default tool policy.
        3. Instantiate each enabled guardrail by name from the registry.
        4. Disabled rules are skipped silently.
        5. Unknown names raise :class:`~agent_service_maf.core.exceptions.ConfigurationError`.

        Tool guardrails (``ToolAuthorizer``, ``ToolParamValidator``) are always
        added when their classes are registered, regardless of whether the input/
        output rules have per-agent overrides.

        Args:
            config: The guardrail section from the merged ``AgentConfig``.
            agent_id: Optional agent identifier to look up per-agent overrides.

        Returns:
            A fully assembled :class:`~agent_service_maf.guardrails.pipeline.GuardrailPipeline`.

        Raises:
            ConfigurationError: If a guardrail name in the config is not registered.
                Check that the guardrail module is imported before calling
                ``build_pipeline``.

        Example:
            >>> from agent_service_maf.config.validators import AgentConfig
            >>> config = AgentConfig()
            >>> pipeline = GuardrailRegistry.build_pipeline(config.guardrails, agent_id="echo")
        """
        if not config.enabled:
            logger.info(
                "Guardrails disabled — returning passthrough pipeline",
                agent_id=agent_id,
            )
            return GuardrailPipeline(fail_open=config.fail_open)

        # ----------------------------------------------------------------
        # Resolve per-agent overrides
        # ----------------------------------------------------------------
        override = config.agent_overrides.get(agent_id) if agent_id else None

        input_rules: list[GuardrailRule] = list(
            override.input_guardrails
            if override and override.input_guardrails
            else config.input_guardrails
        )
        output_rules: list[GuardrailRule] = list(
            override.output_guardrails
            if override and override.output_guardrails
            else config.output_guardrails
        )
        tool_policy: ToolPolicy = (
            override.tool_policy
            if override and override.tool_policy is not None
            else config.tool_guardrails
        )

        # ----------------------------------------------------------------
        # Instantiate guardrails
        # ----------------------------------------------------------------
        input_instances = cls._build_input_guardrails(input_rules)
        output_instances = cls._build_output_guardrails(output_rules)
        tool_instances = cls._build_tool_guardrails(tool_policy)

        logger.info(
            "Built guardrail pipeline",
            agent_id=agent_id,
            input_count=len(input_instances),
            output_count=len(output_instances),
            tool_count=len(tool_instances),
        )

        return GuardrailPipeline(
            input_guardrails=input_instances,
            output_guardrails=output_instances,
            tool_guardrails=tool_instances,
            fail_open=config.fail_open,
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _merge_rule_into_config(rule: GuardrailRule) -> dict[str, Any]:
        """Merge rule-level fields into the guardrail config dict.

        Team JSON keeps ``action_on_trigger`` (and an optional custom ``message``)
        at the rule level — a single source of truth — but guardrail constructors
        only receive ``rule.config``. This helper copies ``rule.config`` and
        injects those rule-level fields so the guardrail instance can honour them
        (see :func:`~agent_service_maf.guardrails.base.resolve_action`).

        Precedence: an **explicitly set** rule-level ``action_on_trigger`` wins
        over an ``action_on_trigger`` key inside ``rule.config``. When the rule
        omits the field, it is not injected, so the guardrail falls back to its
        own per-guardrail default (e.g. ``pii_masker`` → ``modify``).

        Args:
            rule: The guardrail rule to read ``config``, ``action_on_trigger``,
                and ``message`` from.

        Returns:
            A new dict safe to pass to ``_instantiate_guardrail``. Guardrails that
            do not read ``action_on_trigger`` / ``message`` ignore the extra keys.
        """
        merged: dict[str, Any] = dict(rule.config)
        if "action_on_trigger" in rule.model_fields_set:
            merged["action_on_trigger"] = rule.action_on_trigger
        if rule.message is not None:
            merged["message"] = rule.message
        return merged

    @classmethod
    def _build_input_guardrails(cls, rules: list[GuardrailRule]) -> list[InputGuardrail]:
        """Instantiate enabled input guardrails from rule configs.

        Args:
            rules: Ordered list of :class:`~agent_service_maf.config.validators.GuardrailRule`.

        Returns:
            Ordered list of instantiated :class:`InputGuardrail` objects.

        Raises:
            ConfigurationError: If a rule name is not in ``_input_guardrails``.
        """
        result: list[InputGuardrail] = []
        for rule in rules:
            if not rule.enabled:
                logger.debug("Skipping disabled input guardrail", name=rule.name)
                continue
            klass = cls._input_guardrails.get(rule.name)
            if klass is None:
                available = sorted(cls._input_guardrails.keys())
                raise ConfigurationError(
                    f"Input guardrail '{rule.name}' is not registered. "
                    f"Available input guardrails: {available}. "
                    f"Ensure the guardrail module is imported in guardrails/__init__.py "
                    f"before calling GuardrailRegistry.build_pipeline().",
                    details={"requested": rule.name, "available": available},
                )
            merged_config = cls._merge_rule_into_config(rule)
            instance = cast(InputGuardrail, cls._instantiate_guardrail(klass, merged_config))
            result.append(instance)
        return result

    @classmethod
    def _build_output_guardrails(cls, rules: list[GuardrailRule]) -> list[OutputGuardrail]:
        """Instantiate enabled output guardrails from rule configs.

        Args:
            rules: Ordered list of :class:`~agent_service_maf.config.validators.GuardrailRule`.

        Returns:
            Ordered list of instantiated :class:`OutputGuardrail` objects.

        Raises:
            ConfigurationError: If a rule name is not in ``_output_guardrails``.
        """
        result: list[OutputGuardrail] = []
        for rule in rules:
            if not rule.enabled:
                logger.debug("Skipping disabled output guardrail", name=rule.name)
                continue
            klass = cls._output_guardrails.get(rule.name)
            if klass is None:
                available = sorted(cls._output_guardrails.keys())
                raise ConfigurationError(
                    f"Output guardrail '{rule.name}' is not registered. "
                    f"Available output guardrails: {available}. "
                    f"Ensure the guardrail module is imported in guardrails/__init__.py "
                    f"before calling GuardrailRegistry.build_pipeline().",
                    details={"requested": rule.name, "available": available},
                )
            merged_config = cls._merge_rule_into_config(rule)
            instance = cast(OutputGuardrail, cls._instantiate_guardrail(klass, merged_config))
            result.append(instance)
        return result

    @classmethod
    def _build_tool_guardrails(cls, policy: ToolPolicy) -> list[ToolGuardrail]:
        """Build tool guardrail instances from a tool policy.

        Tool guardrails are not configured via rule lists — they are always
        registered if their classes are in the registry. The ``policy`` object
        is passed to the ``ToolAuthorizer`` constructor.

        Args:
            policy: The :class:`~agent_service_maf.config.validators.ToolPolicy`
                resolved for this agent.

        Returns:
            Ordered list of instantiated :class:`ToolGuardrail` objects.
        """
        result: list[ToolGuardrail] = []

        # ToolCallCounter must be built first so ToolAuthorizer can reference it
        tool_counter_cls = cls._tool_guardrails.get("tool_call_counter")
        tool_auth_cls = cls._tool_guardrails.get("tool_authorizer")
        param_val_cls = cls._tool_guardrails.get("tool_param_validator")

        if tool_auth_cls is not None:
            if tool_counter_cls is not None:
                counter_instance = cast(
                    ToolGuardrail, cls._instantiate_guardrail(tool_counter_cls, {})
                )
                authorizer_instance = cast(
                    ToolGuardrail,
                    cls._instantiate_guardrail(
                        tool_auth_cls, {}, policy=policy, counter=counter_instance
                    ),
                )
            else:
                authorizer_instance = cast(
                    ToolGuardrail,
                    cls._instantiate_guardrail(tool_auth_cls, {}, policy=policy),
                )
            result.append(authorizer_instance)

        if param_val_cls is not None:
            result.append(cast(ToolGuardrail, cls._instantiate_guardrail(param_val_cls, {})))

        return result

    @classmethod
    def _instantiate_guardrail(
        cls,
        klass: type[InputGuardrail] | type[OutputGuardrail] | type[ToolGuardrail],
        config: dict[str, Any],
        **kwargs: object,
    ) -> _AnyGuardrail:
        """Instantiate a guardrail class with its config dict.

        Tries ``klass(config=config, **kwargs)`` first, then falls back to
        ``klass(**config, **kwargs)`` for simpler constructors, then finally to
        ``klass(**kwargs)`` for argument-less guardrails.

        The final no-arg fallback matters because
        :meth:`_merge_rule_into_config` always injects ``action_on_trigger`` (and
        optionally ``message``) into the config dict. Guardrails whose ``__init__``
        accepts neither ``config=`` nor those keys as kwargs would otherwise fail —
        so we drop the config entirely as a last resort.

        Args:
            klass: The guardrail class to instantiate.
            config: The merged config dict to pass.
            **kwargs: Additional keyword arguments (e.g., ``policy``, ``counter``).

        Returns:
            An instance of the guardrail class.

        Raises:
            ConfigurationError: If the class cannot be instantiated at all.
        """
        # Prefer explicit config= kwarg; fall back to unpacking config dict;
        # finally try a no-arg constructor (config is then ignored).
        try:
            return klass(config=config, **kwargs)  # type: ignore[call-arg]
        except TypeError:
            pass
        try:
            return klass(**config, **kwargs)
        except TypeError:
            pass
        try:
            return klass(**kwargs)  # type: ignore[call-arg]
        except TypeError as exc:
            raise ConfigurationError(
                f"Cannot instantiate guardrail '{klass.__name__}' "
                f"with config {config!r}. Error: {exc}. "
                f"Review the guardrail's __init__ signature and the "
                f"config section in agent_config.json.",
                details={"class": klass.__name__, "config": config},
            ) from exc

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    @classmethod
    def list_input_guardrails(cls) -> list[str]:
        """Return sorted list of registered input guardrail names.

        Returns:
            Sorted list of registered input guardrail name strings.
        """
        return sorted(cls._input_guardrails.keys())

    @classmethod
    def list_output_guardrails(cls) -> list[str]:
        """Return sorted list of registered output guardrail names.

        Returns:
            Sorted list of registered output guardrail name strings.
        """
        return sorted(cls._output_guardrails.keys())

    @classmethod
    def list_tool_guardrails(cls) -> list[str]:
        """Return sorted list of registered tool guardrail names.

        Returns:
            Sorted list of registered tool guardrail name strings.
        """
        return sorted(cls._tool_guardrails.keys())
