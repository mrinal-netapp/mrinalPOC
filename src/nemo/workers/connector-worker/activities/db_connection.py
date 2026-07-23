"""Shared Postgres/MySQL connection helpers for database activities and explorer adapters."""
import ssl
from typing import Any, Dict, Optional


def _normalize_ssl_mode(config: Dict[str, Any]) -> str:
    """Return ssl_mode from connector config (snake_case), defaulting to prefer."""
    raw = config.get("ssl_mode") or config.get("sslMode") or "prefer"
    return str(raw).strip().lower() or "prefer"


def _postgres_sslmode(ssl_mode: str) -> str:
    """Map connector ssl_mode to a psycopg2 sslmode value."""
    allowed = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
    mode = (ssl_mode or "prefer").strip().lower()
    return mode if mode in allowed else "prefer"


def _mysql_ssl_context(ssl_mode: str) -> Optional[ssl.SSLContext]:
    """Build a PyMySQL ssl= argument from connector ssl_mode."""
    mode = (ssl_mode or "prefer").strip().lower()
    if mode in ("disable", ""):
        return None
    if mode in ("prefer", "require"):
        ctx = ssl.SSLContext()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    if mode == "verify-ca":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        return ctx
    if mode == "verify-full":
        return ssl.create_default_context()
    # Unknown value: encrypt like require (matches common managed-DB defaults).
    ctx = ssl.SSLContext()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def connect_postgres(config: Dict[str, Any], creds: Dict[str, str], timeout_ms: int = 30000):
    """Connect to Postgres. Uses config['database'] if set, else 'postgres' (for listing databases)."""
    import psycopg2

    dbname = config.get("database") or "postgres"
    conn = psycopg2.connect(
        host=config["host"],
        port=config.get("port", 5432),
        dbname=dbname,
        user=creds["username"],
        password=creds["password"],
        connect_timeout=30,
        sslmode=_postgres_sslmode(_normalize_ssl_mode(config)),
    )
    conn.set_session(autocommit=True)
    with conn.cursor() as cur:
        cur.execute(f"SET statement_timeout = {timeout_ms}")
    return conn


def connect_mysql(config: Dict[str, Any], creds: Dict[str, str]):
    """Connect to MySQL. Uses config['database'] if set, else None (for listing databases)."""
    import pymysql

    database = config.get("database") or None
    if database == "":
        database = None
    kwargs: Dict[str, Any] = {
        "host": config["host"],
        "port": config.get("port", 3306),
        "database": database,
        "user": creds["username"],
        "password": creds["password"],
        "connect_timeout": 30,
    }
    ssl_ctx = _mysql_ssl_context(_normalize_ssl_mode(config))
    if ssl_ctx is not None:
        kwargs["ssl"] = ssl_ctx
    return pymysql.connect(**kwargs)
