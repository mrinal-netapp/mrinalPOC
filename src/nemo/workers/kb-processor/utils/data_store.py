"""Local POSIX storage utilities for KB processor.

All file operations use the default app-scoped PVC volume
(NEMO_DEFAULT_STORE_ROOT).  No S3 client or boto3 calls are made by the
worker -- the mount exposes the same bucket data via the filesystem.
"""

import json as _json_mod
from observability_client_runtime import get_logger
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional

logger = get_logger()


def default_store_root() -> str:
    """Return the default app-scoped PVC mount root (NEMO_DEFAULT_STORE_ROOT).

    Raises RuntimeError when the mount is not configured, since all worker
    data access goes through this path.
    """
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError(
            "NEMO_DEFAULT_STORE_ROOT is not set. The worker requires a locally "
            "mounted POSIX volume for all data access."
        )
    return p


def posix_path(key: str) -> Path:
    """Map a storage key to a local path under NEMO_DEFAULT_STORE_ROOT."""
    return Path(default_store_root()) / key


def upload_directory(local_path: Path, dest_prefix: str) -> None:
    """Copy a local directory tree to the POSIX mount."""
    dest = posix_path(dest_prefix)
    for file_path in local_path.rglob('*'):
        if file_path.is_file():
            relative_path = file_path.relative_to(local_path)
            target = dest / str(relative_path).replace('\\', '/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(file_path), str(target))
    logger.info("Copied directory to %s", dest)


def download_file(key: str, local_path) -> None:
    """Copy a file from the POSIX mount to a local path."""
    src = posix_path(key)
    Path(str(local_path)).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(local_path))


def put_json_object(key: str, data: dict) -> None:
    """Write a JSON object to the POSIX mount (atomic via tmp+rename)."""
    p = posix_path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(_json_mod.dumps(data, indent=2))
    tmp.rename(p)
    logger.debug("Wrote JSON to %s", p)


def read_json_object(key: str) -> Optional[dict]:
    """Read a JSON object from the POSIX mount. Returns None if missing."""
    p = posix_path(key)
    if not p.is_file():
        return None
    return _json_mod.loads(p.read_bytes())


def list_files(prefix: str) -> List[str]:
    """List all file keys under a prefix on the POSIX mount."""
    base = posix_path(prefix)
    if not base.is_dir():
        return []
    return sorted(
        f"{prefix}/{p.relative_to(base)}"
        for p in base.rglob("*")
        if p.is_file()
    )


def list_subdirs(prefix: str) -> List[str]:
    """List immediate subdirectory keys under a prefix on the POSIX mount."""
    base = posix_path(prefix)
    if not base.is_dir():
        return []
    return sorted(
        f"{prefix}/{d.name}"
        for d in base.iterdir()
        if d.is_dir()
    )


def delete_tree(prefix: str) -> None:
    """Remove an entire prefix tree from the POSIX mount."""
    target = posix_path(prefix)
    if target.is_dir():
        shutil.rmtree(str(target), ignore_errors=True)
    elif target.is_file():
        target.unlink(missing_ok=True)
