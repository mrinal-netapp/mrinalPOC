"""Load deployments/<cloud>/envs/<env>.yaml with shared pick helpers.

Infra runners (deployments/*/scripts/infra.sh) may import this module in a
follow-up to dedupe embedded Python env-yaml transforms.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEPLOYMENTS_DIR = Path(__file__).resolve().parent.parent


def pick(*values: Any, default: Any = None) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value == "":
            continue
        return value
    return default


def cloud_dir(cloud: str) -> str:
    return "gcp" if cloud == "gke" else cloud


def env_file_path(cloud: str, env_name: str) -> Path:
    return DEPLOYMENTS_DIR / cloud_dir(cloud) / "envs" / f"{env_name}.yaml"


def load_path(path: Path | str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load(cloud: str, env_name: str) -> dict[str, Any]:
    path = env_file_path(cloud, env_name)
    if not path.is_file():
        raise FileNotFoundError(f"env config not found: {path}")
    return load_path(path)


def storage_trident(root: dict[str, Any]) -> dict[str, Any]:
    storage = root.get("storage") or {}
    trident = storage.get("trident") or {}
    installer = root.get("installer") or {}
    return {
        "namespace": pick(trident.get("namespace"), default="trident"),
        "helm_version": pick(
            trident.get("helmVersion"),
            trident.get("helm_version"),
            installer.get("tridentHelmVersion"),
            default="100.2410.0",
        ),
        "service_account": pick(
            trident.get("serviceAccount"),
            trident.get("serviceAccountName"),
            trident.get("kubernetes_service_account"),
            default="trident-controller",
        ),
        "gsa_name": pick(trident.get("gsaName"), trident.get("gsa_name"), default="trident-controller"),
    }


def pick_path(root: dict[str, Any], path: str, default: Any = None) -> Any:
    cur: Any = root
    for part in path.split("."):
        if not isinstance(cur, dict):
            return default
        if part not in cur:
            return default
        cur = cur[part]
    if cur is None:
        return default
    if isinstance(cur, str) and cur == "":
        return default
    return cur


def _env_yaml_cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Pick a value from a deployments env yaml file.")
    parser.add_argument("--file", required=True, help="Path to env yaml")
    parser.add_argument("--path", required=True, help="Dot-separated key path (e.g. gke.clusterName)")
    parser.add_argument("--default", default="", help="Default when path is missing or empty")
    args = parser.parse_args()
    root = load_path(args.file)
    value = pick_path(root, args.path, default=args.default)
    print("" if value is None else value)


if __name__ == "__main__":
    _env_yaml_cli()
