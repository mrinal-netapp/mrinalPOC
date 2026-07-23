"""Unit tests for built-in connector provider registry."""
from __future__ import annotations

import sys
from pathlib import Path

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from adapters.registry import get, list_providers  # noqa: E402


def test_builtin_database_and_objectstore_providers_registered():
    providers = set(list_providers())
    assert {"s3", "postgresql", "mysql", "ontap", "gcp", "azure_cloud", "redash"}.issubset(providers)


def test_get_returns_adapter_for_postgresql():
    adapter = get("postgresql")
    assert adapter is not None
    assert adapter.__class__.__name__ == "PostgreSQLAdapter"


def test_get_returns_none_for_unknown_provider():
    assert get("not-a-provider") is None
