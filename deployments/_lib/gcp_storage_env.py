#!/usr/bin/env python3
"""Emit shell export statements for GKE GCNV storage bootstrap from a GCP env yaml.

Used by mk/cloud/gke.mk gke-ensure-storage-ready when make deploy runs in
env-file mode (DEPLOY_ENV_FILE=deployments/gcp/envs/<env>.yaml).
"""

from __future__ import annotations

import argparse
import shlex
import sys
from pathlib import Path

_LIB_DIR = Path(__file__).resolve().parent
_STORAGE_LIB = _LIB_DIR.parent / "storage" / "lib"
sys.path.insert(0, str(_STORAGE_LIB))
sys.path.insert(0, str(_LIB_DIR))

import env_yaml  # noqa: E402
from gcp_gcnv import _pick_storage  # noqa: E402


def shell_exports(cfg: dict) -> list[str]:
    trident = cfg["trident"]
    pairs = {
        "GCP_PROJECT_ID": cfg["project_id"],
        "GCNV_LOCATION": cfg["gcnv_location"],
        "GCNV_NETWORK": cfg["gcnv_network"],
        "TRIDENT_GSA_EMAIL": cfg["gsa_email"],
        "TRIDENT_NAMESPACE": trident["namespace"],
        "TRIDENT_KSA": trident["service_account"],
        "GCNV_NAS_POOL_NAME": cfg["nas_pool"],
        "GCNV_SAN_POOL_NAME": cfg["san_pool"],
        "GCNV_NAS_SERVICE_LEVEL": cfg["nas_service_level"],
        "GCNV_NAS_POOL_CAPACITY_GIB": cfg["nas_cap"],
        "GCNV_SAN_POOL_CAPACITY_GIB": cfg["san_cap"],
        "GCNV_NAS_BACKEND_NAME": cfg["nas_backend"],
        "GCNV_SAN_BACKEND_NAME": cfg["san_backend"],
        "GCNV_NAS_SC_NAME": cfg["nas_sc"],
        "GCNV_SAN_SC_NAME": cfg["san_sc"],
        "GCNV_SAN_FSTYPE": cfg["san_fstype"],
    }
    return [f"export {key}={shlex.quote(str(value))}" for key, value in pairs.items() if value]


def main() -> None:
    parser = argparse.ArgumentParser(description="Emit GKE GCNV storage env exports from a GCP env yaml.")
    parser.add_argument("--file", required=True, help="Path to deployments/gcp/envs/<env>.yaml")
    args = parser.parse_args()
    root = env_yaml.load_path(args.file)
    cfg = _pick_storage(root)
    print("\n".join(shell_exports(cfg)))


if __name__ == "__main__":
    main()
