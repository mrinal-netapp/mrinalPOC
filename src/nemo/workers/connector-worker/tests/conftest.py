"""Shared pytest configuration for connector-worker tests."""

from __future__ import annotations

import sys
from pathlib import Path

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

_WORKERS_ROOT = _WORKER_ROOT.parent
if str(_WORKERS_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKERS_ROOT))
