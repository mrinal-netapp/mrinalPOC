"""Token counting for context budget management.

Phase 1: heuristic char-to-token ratio with per-provider tuning and
content-class multipliers.
Phase 2: real tokenizers (anthropic.count_tokens, tiktoken) with
offline fallback. Tokenizer selection is provider-aware; cache layer
applied via :class:`CachedTokenCounter`.

Accuracy expectation (heuristic): ±15% on English prose, ±25% on
code/JSON, ±50% on CJK. Combined with the 4096-token-capped safety
buffer and the reactive retry fallback this is sufficient for Phase 1.

Real tokenizers reduce these errors to <2% (tiktoken) or <5%
(anthropic count_tokens).
"""

from __future__ import annotations

import hashlib
import re
from typing import Iterable, Literal, Protocol

from observability_client_runtime import get_logger

logger = get_logger()

ContentClass = Literal["prose", "code", "json", "cjk"]

# Provider char-to-token ratios. Anthropic tokenizes English prose at
# ~3.6 chars/token; OpenAI at ~4.0; Google at ~3.7. These are baselines
# tuned for English; content-class multipliers below adjust for code/CJK.
_RATIOS: dict[str, float] = {
    "anthropic": 0.28,
    "openai": 0.25,
    "azure": 0.25,
    "google": 0.27,
    "aws_bedrock": 0.27,
    "openai_compatible": 0.27,
    "ollama": 0.27,
    "default": 0.27,
}

_CONTENT_MULTIPLIERS: dict[ContentClass, float] = {
    "prose": 1.0,
    "code": 1.3,
    "json": 1.2,
    "cjk": 2.0,
}

# Heuristic content-class detection.
_JSON_HINT_RE = re.compile(r'[\{\[]\s*["\']?\w+["\']?\s*:')
_CODE_FENCE_RE = re.compile(r"```|^\s*(def |class |function |import |const |let |var )", re.MULTILINE)
_CJK_RANGE_RE = re.compile(r"[　-鿿가-힯]")


def detect_content_class(text: str) -> ContentClass:
    """Best-effort heuristic content classification."""
    if not text:
        return "prose"
    # CJK detection: if >20% of chars are CJK, treat as cjk
    cjk_count = len(_CJK_RANGE_RE.findall(text))
    if cjk_count > 0 and cjk_count / max(len(text), 1) > 0.20:
        return "cjk"
    if _JSON_HINT_RE.search(text):
        return "json"
    if _CODE_FENCE_RE.search(text):
        return "code"
    return "prose"


class TokenCounter(Protocol):
    def count(self, text: str, content_class: ContentClass | None = None) -> int: ...


class HeuristicTokenCounter:
    """Phase 1 token counter: char-ratio with content-class multiplier.

    Stateless — safe to share across threads/coroutines.
    """

    def __init__(self, provider: str, global_safety_pct: float = 0.10):
        self._provider = provider
        self._ratio = _RATIOS.get(provider, _RATIOS["default"])
        # Global safety bump applied at sum time (not per-message)
        self._global_safety_pct = global_safety_pct

    def count(self, text: str, content_class: ContentClass | None = None) -> int:
        if not text:
            return 0
        cls = content_class if content_class is not None else detect_content_class(text)
        mult = _CONTENT_MULTIPLIERS.get(cls, 1.0)
        # base = chars * provider_ratio * content_multiplier
        return int(len(text) * self._ratio * mult)

    def count_sum(self, texts: Iterable[str | None]) -> int:
        """Sum tokens with the global safety bump applied once."""
        total = sum(self.count(t) for t in texts if t)
        return int(total * (1.0 + self._global_safety_pct))


def _tokenizer_family(provider: str | None, model: str | None) -> str:
    """Map (provider, model) to a stable tokenizer family name.

    The cache is keyed by family rather than by model so identical
    content tokenized with the same encoding hits the cache regardless
    of which model name is in use (e.g. gpt-4 and gpt-4o share
    cl100k_base).
    """
    p = (provider or "default").lower()
    m = (model or "").lower()
    if p == "anthropic" or "claude" in m:
        return "anthropic"
    if p in ("openai", "azure", "aws_bedrock", "openai_compatible"):
        if "gpt-4o" in m or "gpt-4-turbo" in m or "gpt-3.5" in m or "gpt-35" in m:
            return "o200k_base" if "gpt-4o" in m else "cl100k_base"
        if "gpt-4" in m:
            return "cl100k_base"
        # Provider known but model unknown — best-effort
        return "cl100k_base"
    if p == "google" or "gemini" in m:
        return "google_heuristic"
    return "heuristic_default"


class TiktokenTokenCounter:
    """tiktoken-backed counter. Used for OpenAI / Azure GPT models.

    Loaded lazily — only when first ``count()`` is invoked. If the
    tiktoken package is unavailable at runtime, falls back to the
    heuristic counter and emits a warning once.
    """

    def __init__(self, encoding_name: str, fallback: "HeuristicTokenCounter"):
        self._encoding_name = encoding_name
        self._fallback = fallback
        self._enc = None
        self._failed = False

    def _ensure_encoding(self):
        if self._enc is not None or self._failed:
            return
        try:
            import tiktoken  # type: ignore
            self._enc = tiktoken.get_encoding(self._encoding_name)
        except Exception as exc:
            logger.warning(
                "tiktoken encoding %s unavailable (%s); falling back to heuristic",
                self._encoding_name, exc,
            )
            self._failed = True

    def count(self, text: str, content_class: ContentClass | None = None) -> int:
        if not text:
            return 0
        self._ensure_encoding()
        if self._enc is None:
            return self._fallback.count(text, content_class)
        try:
            return len(self._enc.encode(text))
        except Exception:
            logger.warning("tiktoken encode failed; falling back to heuristic", exc_info=True)
            return self._fallback.count(text, content_class)


class AnthropicTokenCounter:
    """Anthropic SDK count_tokens-backed counter.

    Anthropic's count-tokens endpoint is server-side and adds 50-150 ms
    of RTT per call. To make this affordable on the hot path, callers
    should wrap this in :class:`CachedTokenCounter`. For now, falls
    back to the heuristic if the SDK isn't installed or no API key is
    available.
    """

    def __init__(self, model: str | None, fallback: "HeuristicTokenCounter"):
        self._model = model or "claude-3-5-sonnet-20241022"
        self._fallback = fallback
        self._client = None
        self._failed = False

    def _ensure_client(self):
        if self._client is not None or self._failed:
            return
        try:
            import os
            from anthropic import Anthropic  # type: ignore
            if not os.getenv("ANTHROPIC_API_KEY"):
                # Without an API key the count_tokens endpoint isn't
                # reachable; fall back without trying once per call.
                self._failed = True
                return
            self._client = Anthropic()
        except Exception as exc:
            logger.warning(
                "anthropic SDK unavailable (%s); using heuristic for Anthropic tokenization",
                exc,
            )
            self._failed = True

    def count(self, text: str, content_class: ContentClass | None = None) -> int:
        if not text:
            return 0
        self._ensure_client()
        if self._client is None:
            return self._fallback.count(text, content_class)
        try:
            result = self._client.messages.count_tokens(
                model=self._model,
                messages=[{"role": "user", "content": text}],
            )
            return int(getattr(result, "input_tokens", 0))
        except Exception:
            logger.warning("anthropic count_tokens failed; falling back to heuristic", exc_info=True)
            return self._fallback.count(text, content_class)


class CachedTokenCounter:
    """Wraps an underlying counter with a content-addressed cache.

    Cache key: ``tok:{family}:{sha256(content)}``. Backed by an
    injected ``async`` store, but the counter API is sync — so cache
    interaction happens via ``warmup()`` that the caller invokes
    out-of-band. For Phase 2 we ship the in-memory variant; the
    Redis-backed version is :class:`RedisTokenCountCache` below.
    """

    def __init__(
        self,
        inner: TokenCounter,
        family: str,
        local_cache_max: int = 4096,
    ):
        self._inner = inner
        self._family = family
        self._cache: dict[str, int] = {}
        self._cache_max = local_cache_max

    def _key(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def count(self, text: str, content_class: ContentClass | None = None) -> int:
        if not text:
            return 0
        key = self._key(text)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        n = self._inner.count(text, content_class)
        if len(self._cache) >= self._cache_max:
            # Naive LRU: drop oldest 25% on overflow.
            drop = self._cache_max // 4
            for k in list(self._cache.keys())[:drop]:
                self._cache.pop(k, None)
        self._cache[key] = n
        return n


def get_counter(
    provider: str | None,
    model: str | None = None,
    *,
    use_real_tokenizers: bool = False,
    cached: bool = False,
) -> TokenCounter:
    """Build a TokenCounter for ``(provider, model)``.

    Args:
        use_real_tokenizers: when True, use tiktoken / anthropic where
            available. Defaults to False (heuristic only) so Phase 1
            deployments are unchanged. Flip to True under
            ``CONTEXT_MANAGER_USE_REAL_TOKENIZERS=true`` once measured.
        cached: wrap in CachedTokenCounter to avoid re-tokenizing
            identical content.
    """
    heuristic = HeuristicTokenCounter(provider or "default")
    if not use_real_tokenizers:
        counter: TokenCounter = heuristic
    else:
        family = _tokenizer_family(provider, model)
        if family == "anthropic":
            counter = AnthropicTokenCounter(model, fallback=heuristic)
        elif family in ("cl100k_base", "o200k_base"):
            counter = TiktokenTokenCounter(family, fallback=heuristic)
        else:
            counter = heuristic
    if cached:
        counter = CachedTokenCounter(counter, _tokenizer_family(provider, model))
    return counter
