"""System-prompt / chain-of-thought leakage guardrail (Task 003 #6).

Output-phase guardrail that flags responses leaking the agent's hidden system
instructions or internal reasoning.

- **System-prompt leak:** regex phrase heuristics ("my instructions are",
  "system prompt", "you are a … assistant" …). Optionally, if
  ``ctx.extra["system_prompt"]`` is present, a ``rapidfuzz`` similarity check
  compares the response against the actual system prompt. **That wiring is out
  of scope for this task**, so the similarity path is **dormant by default** and
  the guardrail operates regex-only; the code activates it automatically if the
  field is ever populated.
- **CoT leak:** regex markers ("let me think step by step", "reasoning:",
  ``<thinking>``, "chain of thought" …).

Detection only — never ``MODIFY`` (no redaction). Default action ``warn``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import structlog

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    OutputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

_LEAKAGE_ALLOWED_ACTIONS = frozenset({GuardrailAction.WARN, GuardrailAction.BLOCK})

_DEFAULT_SIMILARITY_THRESHOLD = 0.85

#: System-prompt leak phrase heuristics.
_SYSTEM_PROMPT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\bmy\s+(system\s+)?instructions\s+(are|were|state)\b",
        r"\bsystem\s+prompt\b",
        r"\bmy\s+system\s+message\b",
        r"\bI\s+(was|am)\s+(instructed|told|programmed)\s+to\b",
        r"\byou\s+are\s+a[n]?\s+\w+\s+(assistant|agent|bot)\b",
        r"\bthe\s+instructions\s+(above|provided)\b",
    ]
]

#: Chain-of-thought leak markers.
_COT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"\bthink(?:ing)?\s+step[\s-]by[\s-]step\b",
        r"\breasoning\s*:",
        r"</?thinking>",
        r"\bchain[\s-]of[\s-]thought\b",
        r"\bscratchpad\b",
        r"\bmy\s+(internal\s+)?(reasoning|thought\s+process)\b",
    ]
]


def _rapidfuzz_ratio(a: str, b: str) -> float | None:
    """Return a 0–1 partial similarity ratio, or ``None`` if rapidfuzz is unavailable."""
    try:
        from rapidfuzz import fuzz
    except ImportError:
        return None
    return float(fuzz.partial_ratio(a, b)) / 100.0


@dataclass
class LeakageConfig:
    """Resolved system-prompt/CoT leakage configuration."""

    detect_system_prompt: bool = True
    detect_cot: bool = True
    similarity_threshold: float = _DEFAULT_SIMILARITY_THRESHOLD

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> LeakageConfig:
        """Build from a config dict."""
        return cls(
            detect_system_prompt=bool(config.get("detect_system_prompt", True)),
            detect_cot=bool(config.get("detect_cot", True)),
            similarity_threshold=float(
                config.get("similarity_threshold", _DEFAULT_SIMILARITY_THRESHOLD)
            ),
        )


@GuardrailRegistry.register_output("system_prompt_leakage")
class SystemPromptLeakageGuard(OutputGuardrail):
    r"""Detects leaked system instructions or chain-of-thought in agent output.

    Args:
        config: Optional config dict. Recognised keys: ``detect_system_prompt``
            (bool, default ``True``), ``detect_cot`` (bool, default ``True``),
            ``similarity_threshold`` (float 0–1, default ``0.85``); plus
            ``action_on_trigger`` / ``message`` (merged by registry).
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = LeakageConfig.from_dict(cfg)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.WARN,
            allowed=_LEAKAGE_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "system_prompt_leakage"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect system-prompt / CoT leakage and act per ``action_on_trigger``."""
        content = ctx.content
        reasons: list[str] = []

        if self._config.detect_system_prompt:
            if any(p.search(content) for p in _SYSTEM_PROMPT_PATTERNS):
                reasons.append("system_prompt_phrase")
            # Optional similarity path — dormant unless system_prompt was wired in.
            system_prompt = ctx.extra.get("system_prompt")
            if system_prompt:
                ratio = _rapidfuzz_ratio(str(system_prompt), content)
                if ratio is not None and ratio >= self._config.similarity_threshold:
                    reasons.append("system_prompt_similarity")

        if self._config.detect_cot and any(p.search(content) for p in _COT_PATTERNS):
            reasons.append("cot_marker")

        if not reasons:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        logger.warning(
            "Prompt/CoT leakage detected",
            reasons=reasons,
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {"reasons": reasons}

        if self._trigger_action == GuardrailAction.BLOCK:
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=self._custom_message
                or "Response blocked: possible system-prompt / reasoning leakage.",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.WARN,
            guardrail_name=self.name,
            message=self._custom_message
            or "Possible system-prompt / reasoning leakage (allowed with warning).",
            details=details,
        )
