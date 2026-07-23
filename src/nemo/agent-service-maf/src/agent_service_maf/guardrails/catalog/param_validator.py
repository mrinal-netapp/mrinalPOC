"""Tool parameter validator guardrail.

Validates tool call parameters for dangerous patterns before the tool is
executed. Detects path traversal attacks and shell injection sequences.

This is a defence-in-depth measure: even if the tool itself validates its
inputs, this guardrail catches attacks before they reach MCP servers.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    ToolGuardrail,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

#: Patterns indicating path traversal attacks.
_PATH_TRAVERSAL_PATTERNS: list[str] = [
    r"\.\.[/\\]",  # ../  or ..\
    r"/etc/(passwd|shadow|hosts)",  # Unix sensitive files
    r"~[/\\]\.ssh[/\\]",  # SSH key directory
    r"/proc/",  # Linux proc filesystem
    r"[/\\]windows[/\\]system32",  # Windows system directory (case-insensitive)
    r"\.\./\.\./",  # Double traversal
]

#: Patterns indicating shell injection attempts.
_SHELL_INJECTION_PATTERNS: list[str] = [
    r"[;&|`]",  # Shell command separators and backtick
    r"\$\(",  # Command substitution $()
    r"\bsudo\b",  # Privilege escalation
    r"\brm\s+-[rRfF]",  # Recursive delete
    r">\s*/dev/",  # Redirect to device
    r"\bchmod\s+[0-7]{3,4}\b",  # Permission change
    r"\bchown\b",  # Ownership change
    r"\bkill\s+-9\b",  # Force kill
    r"\beval\b",  # Dynamic code execution
    r"<\s*\(",  # Process substitution
]

#: Parameter names that are semantically command-like and warrant
#: shell-injection checks. Kept narrow so generic text/markdown/SQL/URL
#: payloads (which often contain ``;``, ``&``, or ``|``) pass through.
_COMMAND_LIKE_KEYS: frozenset[str] = frozenset(
    {
        "command",
        "cmd",
        "args",
        "argv",
        "shell",
        "exec",
        "script",
        "entrypoint",
    }
)

_COMPILED_PATH: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in _PATH_TRAVERSAL_PATTERNS
]
_COMPILED_SHELL: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE) for p in _SHELL_INJECTION_PATTERNS
]


def _is_command_like_key(key: object) -> bool:
    """Return True when ``key`` names a command-like parameter."""
    return isinstance(key, str) and key.lower() in _COMMAND_LIKE_KEYS


def _check_value(value: object, *, command_like: bool = False) -> str | None:
    """Recursively check a parameter value for dangerous patterns.

    Path-traversal patterns are always checked. Shell-injection patterns
    are only applied to values whose enclosing parameter name is in
    :data:`_COMMAND_LIKE_KEYS` (e.g. ``command``, ``args``, ``cmd``) so
    that generic text — markdown, SQL, query strings, JSON payloads —
    isn't blocked for containing ``;``, ``&``, or ``|``.

    Args:
        value: The parameter value. May be a str, dict, list, or scalar.
        command_like: When True, shell-injection patterns are evaluated
            for this value. Set by the caller after seeing a
            command-like key in the parent dict.

    Returns:
        The name of the first dangerous category found (``"path_traversal"``
        or ``"shell_injection"``), or ``None`` if safe.
    """
    if isinstance(value, str):
        for compiled in _COMPILED_PATH:
            if compiled.search(value):
                return "path_traversal"
        if command_like:
            for compiled in _COMPILED_SHELL:
                if compiled.search(value):
                    return "shell_injection"
    elif isinstance(value, dict):
        for k, v in value.items():
            child_command_like = command_like or _is_command_like_key(k)
            result = _check_value(v, command_like=child_command_like)
            if result:
                return result
    elif isinstance(value, list):
        for item in value:
            result = _check_value(item, command_like=command_like)
            if result:
                return result
    return None


@GuardrailRegistry.register_tool("tool_param_validator")
class ToolParamValidator(ToolGuardrail):
    """Validates tool call parameters for path traversal and shell injection.

    Recursively inspects all string values in ``tool_params`` (including nested
    dicts and lists) for dangerous patterns. Blocks the tool call if any pattern
    matches.

    Args:
        config: Optional configuration dict (currently unused; reserved for
            per-tool pattern overrides in future versions).

    Example:
        >>> validator = ToolParamValidator()
        >>> ctx = GuardrailContext.for_tool(
        ...     "read_file", {"path": "../../etc/passwd"}, "agent", "corr-1"
        ... )
        >>> result = await validator.check(ctx)
        >>> result.action
        <GuardrailAction.BLOCK: 'block'>
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        # Reserved for future per-tool pattern configuration
        pass

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"tool_param_validator"``
        """
        return "tool_param_validator"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Validate tool parameters for dangerous patterns.

        Recursively checks all string values in ``ctx.extra["tool_params"]``
        for path traversal and shell injection patterns.

        Args:
            ctx: Guardrail context with ``guardrail_type="tool"``.
                ``ctx.extra["tool_params"]`` contains the parameters to validate.

        Returns:
            ``BLOCK`` if any dangerous pattern is detected.
            ``ALLOW`` if all parameters are safe.

        Example:
            >>> result = await validator.check(ctx)
        """
        tool_params: dict[str, Any] = ctx.extra.get("tool_params", {})
        tool_name: str = ctx.extra.get("tool_name", "")

        danger = _check_value(tool_params)
        if danger:
            logger.warning(
                "Dangerous tool parameter detected",
                danger_type=danger,
                tool_name=tool_name,
                agent_id=ctx.agent_id,
                correlation_id=ctx.correlation_id,
            )
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=(
                    f"Tool '{tool_name}' parameters contain potentially dangerous content "
                    f"({danger}). Review the tool arguments for path traversal or "
                    f"shell injection patterns."
                ),
                details={"danger_type": danger, "tool_name": tool_name},
            )

        return GuardrailResult(
            action=GuardrailAction.ALLOW,
            guardrail_name=self.name,
        )
