"""Render .yaml.tpl manifests with ${VAR} placeholders."""

from __future__ import annotations

from pathlib import Path
from string import Template


MANIFESTS_DIR = Path(__file__).resolve().parent.parent / "manifests"


def render_template(rel_path: str, variables: dict[str, str]) -> str:
    path = MANIFESTS_DIR / rel_path
    if not path.is_file():
        raise FileNotFoundError(f"manifest template not found: {path}")
    return Template(path.read_text(encoding="utf-8")).safe_substitute(variables)


def storage_pools_block(pool_name: str | None, enabled: bool = True) -> str:
    if not enabled or not pool_name:
        return ""
    return f"  storagePools:\n    - \"{pool_name}\""
