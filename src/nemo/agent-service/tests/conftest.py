"""Shared pytest configuration for agent-service tests."""

import pytest


def pytest_configure(config):
    """Set asyncio_mode to auto so @pytest.mark.asyncio is not required."""
    config.addinivalue_line("markers", "asyncio: mark test as async")
