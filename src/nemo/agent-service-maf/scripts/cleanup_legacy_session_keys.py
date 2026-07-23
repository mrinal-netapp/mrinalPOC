#!/usr/bin/env python3
"""Sweep legacy Phase-1 session keys after the migration window closes.

Phase 2 introduced a scope discriminator + per-user partition in session
keys (see ``docs/MEMORY-DESIGN.md``). For 90 days post-deploy, the
``RedisSessionStore.get`` path falls back to the legacy 2-/3-component
key shape on a miss and copies it forward (lazy migration). After the
window closes, residual legacy keys are no longer reachable and just
sit in Redis until TTL expires.

This script audits and (optionally) deletes those stragglers. It is
SAFE to run at any point during the window: it only deletes keys
matching the legacy shape AND is gated by the ``--apply`` flag --
without it the script runs read-only and prints the counts.

Usage::

    # Audit only (default).
    python scripts/cleanup_legacy_session_keys.py \
        --url redis://localhost:6379/0 \
        --prefix agent_session:

    # Delete the residue. Make sure the audit count is small first.
    python scripts/cleanup_legacy_session_keys.py \
        --url redis://localhost:6379/0 \
        --prefix agent_session: \
        --apply

The script does NOT touch:
    - New-shape keys (``agent_session:team:*`` or ``agent_session:agent:*``)
    - Index Sets or metadata Hashes
    - Task keys (different prefix)
"""

from __future__ import annotations

import argparse
import asyncio
import sys


async def main(url: str, prefix: str, apply: bool, batch_size: int) -> int:
    try:
        import redis.asyncio as aioredis
    except ImportError:
        print("error: install with `pip install redis[hiredis]`", file=sys.stderr)
        return 2

    client = aioredis.from_url(url, decode_responses=True)
    pattern = f"{prefix}*"
    legacy: list[str] = []
    new_count = 0

    print(f"scanning pattern={pattern!r}...")
    async for key in client.scan_iter(match=pattern, count=batch_size):
        suffix = key[len(prefix):]
        first = suffix.split(":", 1)[0] if ":" in suffix else suffix
        if first in ("team", "agent"):
            new_count += 1
        else:
            legacy.append(key)

    print(f"new-shape keys: {new_count}")
    print(f"legacy keys:    {len(legacy)}")

    if not apply:
        print("\n(audit only -- re-run with --apply to delete the legacy keys)")
        await client.aclose()
        return 0

    deleted = 0
    for i in range(0, len(legacy), batch_size):
        batch = legacy[i:i + batch_size]
        if not batch:
            continue
        deleted += await client.delete(*batch)
        print(f"  deleted {deleted}/{len(legacy)}")
    print(f"\ndone. deleted {deleted} legacy keys.")
    await client.aclose()
    return 0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", default="redis://localhost:6379/0", help="Redis URL")
    p.add_argument("--prefix", default="agent_session:", help="Session-key prefix")
    p.add_argument("--apply", action="store_true", help="Delete; otherwise audit only")
    p.add_argument("--batch-size", type=int, default=500, help="SCAN / DELETE batch size")
    return p.parse_args()


if __name__ == "__main__":
    args = parse_args()
    code = asyncio.run(main(args.url, args.prefix, args.apply, args.batch_size))
    sys.exit(code)
