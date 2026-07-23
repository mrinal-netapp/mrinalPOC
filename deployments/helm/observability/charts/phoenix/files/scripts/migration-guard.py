#!/usr/bin/env python3
"""
Phoenix DB migration guard.

Detects Alembic revision mismatches before Phoenix starts and backs up the
incompatible database so Phoenix can initialise fresh rather than enter a
CrashLoopBackOff.

What causes the crash:
  Phoenix manages its schema with Alembic.  The current Alembic revision ID
  is stored in the ``alembic_version`` table of the DB.  If the Phoenix image
  is changed to a version whose migration chain does not contain that stored
  revision (e.g. a version downgrade, or an image that branched from a
  different migration tree), Alembic raises:

    Can't locate revision identified by '<rev>'

  and the container exits with code 1, entering CrashLoopBackOff.

What this guard does:
  1. Reads the stored Alembic revision from the database.
  2. Walks the migration chain embedded in the running Phoenix image.
  3. If the stored revision is NOT present in the chain, the DB is
     incompatible with this image version:
       - SQLite  : the file is renamed to *.incompatible.<epoch>.bak  so
                   Phoenix creates a fresh database on next start.
       - PostgreSQL : the public schema is dropped and recreated so Phoenix
                     runs all migrations from scratch.
  4. If the revision IS present (normal case), no action is taken.

Observability data (traces, spans) is ephemeral by nature; a clean rebuild
on version mismatch is the correct trade-off over a permanent crash loop.
"""
import glob as _glob
import os
import sys
import time

BACKEND = os.environ.get("PHOENIX_DB_BACKEND", "sqlite")
WORKING_DIR = os.environ.get("PHOENIX_WORKING_DIR", "/data")
DATABASE_URL = os.environ.get("PHOENIX_SQL_DATABASE_URL", "")

print(f"[migration-guard] backend={BACKEND}")


def _find_alembic_config():
    """Return the path to Phoenix's alembic.ini, searching the installed package."""
    # Use find_spec instead of `import phoenix` to locate the package directory
    # without executing Phoenix's module code (which reads PHOENIX_PORT at import
    # time and raises ValueError when Kubernetes injects it as "tcp://..." form).
    import importlib.util
    spec = importlib.util.find_spec("phoenix")
    if spec is None or spec.origin is None:
        print("[migration-guard] Phoenix package not found — skipping revision check.")
        return None
    pkg_dir = os.path.dirname(spec.origin)

    candidates = _glob.glob(os.path.join(pkg_dir, "**/alembic.ini"), recursive=True)
    if not candidates:
        print("[migration-guard] alembic.ini not found in Phoenix package — skipping revision check.")
        return None
    return candidates[0]


def _known_revisions(ini_path):
    """Return the set of all revision IDs in the Phoenix migration chain."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(ini_path)
    # Resolve script_location relative to the ini file so it works regardless
    # of the current working directory.
    ini_dir = os.path.dirname(ini_path)
    loc = cfg.get_main_option("script_location", "migrations")
    if not os.path.isabs(loc):
        cfg.set_main_option("script_location", os.path.join(ini_dir, loc))

    script = ScriptDirectory.from_config(cfg)
    return {rev.revision for rev in script.walk_revisions()}


def guard_sqlite():
    db_path = os.path.join(WORKING_DIR, "phoenix.db")

    if not os.path.exists(db_path):
        print("[migration-guard] No SQLite database found — Phoenix will create a fresh one.")
        return

    import sqlite3

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.execute("SELECT version_num FROM alembic_version LIMIT 1")
        row = cur.fetchone()
        conn.close()
    except Exception as exc:
        print(f"[migration-guard] Could not query alembic_version: {exc} — skipping.")
        return

    if not row:
        print("[migration-guard] alembic_version table is empty — fresh DB, nothing to do.")
        return

    stored_rev = row[0]
    print(f"[migration-guard] Stored DB revision: {stored_rev}")

    ini_path = _find_alembic_config()
    if ini_path is None:
        return

    try:
        known = _known_revisions(ini_path)
    except Exception as exc:
        print(f"[migration-guard] Could not read migration chain: {exc} — skipping.")
        return

    if stored_rev in known:
        print(f"[migration-guard] Revision {stored_rev!r} is compatible — no action needed.")
        return

    # Incompatible revision — back up the DB so Phoenix starts clean.
    bak = f"{db_path}.incompatible.{int(time.time())}.bak"
    try:
        os.rename(db_path, bak)
        print(f"[migration-guard] WARNING: revision {stored_rev!r} not in current migration chain.")
        print(f"[migration-guard] Incompatible DB backed up to: {os.path.basename(bak)}")
        print("[migration-guard] Phoenix will initialise a fresh database on next start.")
    except OSError as exc:
        print(f"[migration-guard] Could not back up DB: {exc} — Phoenix may still crash.")


def guard_postgresql():
    if not DATABASE_URL:
        print("[migration-guard] PHOENIX_SQL_DATABASE_URL not set — skipping.")
        return

    # Phoenix ships asyncpg (not psycopg2) as its PostgreSQL driver.
    # Use asyncpg directly via asyncio rather than SQLAlchemy's sync engine.
    try:
        import asyncio
        import asyncpg
    except ImportError:
        print("[migration-guard] asyncpg not available — skipping PostgreSQL check.")
        return

    # Strip SQLAlchemy dialect prefix if ever present (postgresql+asyncpg:// → postgresql://).
    dsn = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")

    async def _run():
        # --- read stored revision ---
        try:
            conn = await asyncpg.connect(dsn=dsn)
        except Exception as exc:
            # DB may not exist yet on a first deploy — Phoenix will create it.
            print(f"[migration-guard] Could not connect to PostgreSQL: {exc} — skipping.")
            return

        try:
            row = await conn.fetchrow(
                "SELECT version_num FROM alembic_version LIMIT 1"
            )
        except Exception as exc:
            # Table doesn't exist yet on a fresh schema — that's fine.
            print(f"[migration-guard] Could not query alembic_version: {exc} — skipping.")
            await conn.close()
            return
        await conn.close()

        if not row:
            print("[migration-guard] alembic_version table is empty — fresh DB, nothing to do.")
            return

        stored_rev = row["version_num"]
        print(f"[migration-guard] Stored DB revision: {stored_rev}")

        # --- check migration chain ---
        ini_path = _find_alembic_config()
        if ini_path is None:
            return

        try:
            known = _known_revisions(ini_path)
        except Exception as exc:
            print(f"[migration-guard] Could not read migration chain: {exc} — skipping.")
            return

        if stored_rev in known:
            print(f"[migration-guard] Revision {stored_rev!r} is compatible — no action needed.")
            return

        # --- incompatible: drop and recreate public schema ---
        print(f"[migration-guard] WARNING: revision {stored_rev!r} not in current migration chain.")
        print("[migration-guard] Dropping PostgreSQL public schema so Phoenix can rebuild.")
        try:
            conn = await asyncpg.connect(dsn=dsn)
            async with conn.transaction():
                await conn.execute("DROP SCHEMA public CASCADE")
                await conn.execute("CREATE SCHEMA public")
            await conn.close()
            print("[migration-guard] Schema reset complete — Phoenix will rebuild on next start.")
        except Exception as exc:
            print(f"[migration-guard] Schema reset failed: {exc} — Phoenix may still crash.")

    asyncio.run(_run())


if BACKEND == "sqlite":
    guard_sqlite()
elif BACKEND == "postgresql":
    guard_postgresql()
else:
    print(f"[migration-guard] Unknown backend {BACKEND!r} — skipping.")

print("[migration-guard] Done.")
