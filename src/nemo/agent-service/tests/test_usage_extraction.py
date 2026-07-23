"""Tests for token usage extraction from agent run results."""

from src.main import _extract_usage


class _MetricsObj:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _RunResponseObj:
    def __init__(self, metrics):
        self.metrics = metrics


def test_extract_usage_from_dict_metrics():
    usage = _extract_usage(
        _RunResponseObj(
            {
                "input_tokens": 120,
                "output_tokens": 45,
                "total_tokens": 165,
            }
        )
    )
    assert usage == {
        "promptTokens": 120,
        "completionTokens": 45,
        "totalTokens": 165,
    }


def test_extract_usage_from_object_metrics():
    usage = _extract_usage(
        _RunResponseObj(
            _MetricsObj(
                input_tokens=5,
                output_tokens=7,
                total_tokens=12,
            )
        )
    )
    assert usage == {
        "promptTokens": 5,
        "completionTokens": 7,
        "totalTokens": 12,
    }


def test_extract_usage_returns_none_when_missing():
    assert _extract_usage(_RunResponseObj({})) is None
    assert _extract_usage(None) is None
