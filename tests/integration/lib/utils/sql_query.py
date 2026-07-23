"""Build sqlQuery strings for structured database datasets (matches GUI / worker conventions)."""

from __future__ import annotations

import re

# Worker parses the first line: -- Database: <name>
_DATABASE_COMMENT_RE = re.compile(r"^\s*--\s*Database:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)


def format_structured_sql_query(
    provider: str,
    database: str,
    schema: str,
    table: str,
    *,
    limit: int | None = None,
) -> str:
    """
    Default sqlQuery for acquired structured datasets.

    PostgreSQL (GUI): -- Database: db\\nSELECT * FROM "schema"."table"
    MySQL (fixtures): -- Database: db\\nSELECT * FROM db.table
    """
    provider_key = provider.lower()
    if provider_key == "postgresql":
        select = f'SELECT * FROM "{schema}"."{table}"'
    elif provider_key == "mysql":
        if schema and schema != database:
            select = f"SELECT * FROM `{database}`.`{schema}`.`{table}`"
        else:
            select = f"SELECT * FROM `{database}`.`{table}`"
    else:
        select = f'SELECT * FROM "{schema}"."{table}"'

    if limit is not None and limit > 0:
        if not re.search(r"\blimit\s+\d+", select, re.IGNORECASE):
            select = f"{select} LIMIT {int(limit)}"

    db_line = database or schema
    return f"-- Database: {db_line}\n{select}"


def resolve_sql_query(
    provider: str,
    raw: str,
    database: str,
    schema: str,
    table: str,
    *,
    default_limit: int | None = 100,
) -> str:
    """
  Normalize user-provided SQL or build from database/schema/table.

  If POSTGRES_SQL_QUERY / MYSQL_SQL_QUERY is empty, generates the platform format.
  If provided without `-- Database:` header, prepends it (required for worker fallback).
    """
    text = (raw or "").strip()
    if not text:
        return format_structured_sql_query(
            provider, database, schema, table, limit=default_limit
        )

    if _DATABASE_COMMENT_RE.search(text):
        return text

    db_name = database or schema
    if db_name:
        return f"-- Database: {db_name}\n{text}"

    return text
