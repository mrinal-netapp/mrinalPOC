"""Tests for the heuristic token counter."""

from src.token_counter import (
    HeuristicTokenCounter,
    detect_content_class,
    get_counter,
)


class TestContentClassDetection:
    def test_prose(self):
        assert detect_content_class("hello world this is plain prose") == "prose"

    def test_json(self):
        assert detect_content_class('{"foo": "bar", "n": 1}') == "json"

    def test_code(self):
        assert detect_content_class("```python\ndef foo(): pass\n```") == "code"

    def test_cjk(self):
        assert detect_content_class("こんにちは世界、これは日本語のテキストです。") == "cjk"

    def test_empty_returns_prose(self):
        assert detect_content_class("") == "prose"


class TestHeuristicTokenCounter:
    def test_zero_for_empty(self):
        c = HeuristicTokenCounter("openai")
        assert c.count("") == 0
        assert c.count(None) == 0  # type: ignore[arg-type]

    def test_anthropic_prose_ratio(self):
        c = HeuristicTokenCounter("anthropic")
        # 100 chars * 0.28 * 1.0 = 28
        assert c.count("x" * 100, content_class="prose") == 28

    def test_openai_prose_ratio(self):
        c = HeuristicTokenCounter("openai")
        # 100 chars * 0.25 * 1.0 = 25
        assert c.count("x" * 100, content_class="prose") == 25

    def test_code_multiplier(self):
        c = HeuristicTokenCounter("openai")
        # 100 * 0.25 * 1.3 = 32
        assert c.count("x" * 100, content_class="code") == 32

    def test_cjk_multiplier(self):
        c = HeuristicTokenCounter("openai")
        # 100 * 0.25 * 2.0 = 50
        assert c.count("x" * 100, content_class="cjk") == 50

    def test_global_safety_bump_in_sum(self):
        c = HeuristicTokenCounter("openai", global_safety_pct=0.10)
        # Each "x"*100 = 25 tokens.  Sum of 2 = 50, +10% = 55
        assert c.count_sum(["x" * 100, "x" * 100]) == 55

    def test_unknown_provider_falls_back_to_default_ratio(self):
        c = HeuristicTokenCounter("not_a_real_provider")
        # default ratio 0.27 * 100 chars = 27
        assert c.count("x" * 100, content_class="prose") == 27


class TestGetCounter:
    def test_returns_heuristic_counter(self):
        c = get_counter("openai", "gpt-4o")
        assert isinstance(c, HeuristicTokenCounter)

    def test_handles_none_provider(self):
        c = get_counter(None)
        assert isinstance(c, HeuristicTokenCounter)
