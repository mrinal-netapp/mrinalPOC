"""Pytest path setup: workers root (for ``shared``) and dataset-processor package."""

import sys
from pathlib import Path

_workers_root = Path(__file__).resolve().parents[2]
_processor_root = Path(__file__).resolve().parents[1]

for p in (_workers_root, _processor_root):
    s = str(p)
    if s not in sys.path:
        sys.path.insert(0, s)
