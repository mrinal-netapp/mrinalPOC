"""MySQL provider adapter for explorer actions. Uses native PyMySQL driver."""
from observability_client_runtime import get_logger
from typing import Any, Dict

from activities.db_connection import connect_mysql

from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter

logger = get_logger()

# System catalogs exposed as databases in SHOW DATABASES / information_schema.schemata.
MYSQL_SYSTEM_SCHEMAS = frozenset(
    {"information_schema", "mysql", "performance_schema", "sys"},
)

_MYSQL_SYSTEM_SCHEMAS_SQL = ", ".join(f"'{name}'" for name in sorted(MYSQL_SYSTEM_SCHEMAS))


def _effective_db(config: Dict[str, Any], payload: Dict[str, Any]):
    """Database to use: payload or connector config. None means no database (list databases)."""
    db = payload.get("database") or config.get("database")
    if db is not None and isinstance(db, str):
        db = db.strip() or None
    return db


def _config_for_db(config: Dict[str, Any], database: str) -> Dict[str, Any]:
    out = dict(config)
    out["database"] = database
    return out


class MySQLAdapter(ProviderAdapter):
    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        try:
            if action == "listDatabases":
                return self._list_databases(connector_config, credential, payload)
            elif action == "listSchemas":
                return self._list_schemas(connector_config, credential, payload)
            elif action == "listTables":
                return self._list_tables(connector_config, credential, payload)
            elif action == "describeTable":
                return self._describe_table(connector_config, credential, payload)
            return ExplorerResponse(
                error=ExplorerError("UNSUPPORTED_ACTION", f"Action '{action}' not supported by MySQL adapter"),
            )
        except Exception as e:
            logger.exception("MySQL adapter error: action=%s", action)
            return ExplorerResponse(
                error=ExplorerError("PROVIDER_ERROR", str(e)),
            )

    def _list_databases(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        conn = connect_mysql(config, creds)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT schema_name FROM information_schema.schemata "
                    f"WHERE schema_name NOT IN ({_MYSQL_SYSTEM_SCHEMAS_SQL}) "
                    "ORDER BY schema_name"
                )
                rows = cur.fetchall()
            nodes = [
                ExplorerNode(
                    id=f"mysql:db/{row[0]}",
                    label=row[0],
                    type="database",
                    children_hint="hasChildren",
                    resource={"database": row[0]},
                    actions=["listSchemas"],
                )
                for row in rows
            ]
            return ExplorerResponse(nodes=nodes)
        finally:
            conn.close()

    def _list_schemas(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        database = _effective_db(config, payload)
        if not database:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "database is required for listSchemas (select a database first)"),
            )
        cfg = _config_for_db(config, database)
        conn = connect_mysql(cfg, creds)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT schema_name FROM information_schema.schemata "
                    f"WHERE schema_name NOT IN ({_MYSQL_SYSTEM_SCHEMAS_SQL}) "
                    "ORDER BY schema_name"
                )
                rows = cur.fetchall()
            nodes = [
                ExplorerNode(
                    id=f"mysql:{database}/{row[0]}",
                    label=row[0],
                    type="schema",
                    children_hint="hasChildren",
                    resource={"database": database, "schema": row[0]},
                    actions=["listTables"],
                )
                for row in rows
            ]
            return ExplorerResponse(nodes=nodes)
        finally:
            conn.close()

    def _list_tables(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        database = _effective_db(config, payload)
        if not database:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "database is required for listTables"),
            )
        schema = payload.get("schema") or config.get("schema") or database
        cfg = _config_for_db(config, database)
        conn = connect_mysql(cfg, creds)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT table_name, table_type FROM information_schema.tables "
                    "WHERE table_schema = %s ORDER BY table_name",
                    (schema,),
                )
                rows = cur.fetchall()
            nodes = [
                ExplorerNode(
                    id=f"mysql:{database}/{schema}/{row[0]}",
                    label=row[0],
                    type="view" if "VIEW" in (row[1] or "").upper() else "table",
                    children_hint="hasChildren",
                    resource={"database": database, "schema": schema, "table": row[0]},
                    actions=["describeTable"],
                )
                for row in rows
            ]
            return ExplorerResponse(nodes=nodes)
        finally:
            conn.close()

    def _describe_table(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        database = _effective_db(config, payload)
        if not database:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "database is required for describeTable"),
            )
        schema = payload.get("schema") or config.get("schema") or database
        table = payload.get("table")
        if not table:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "table is required in payload for describeTable"),
            )
        cfg = _config_for_db(config, database)
        conn = connect_mysql(cfg, creds)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT column_name, data_type, is_nullable "
                    "FROM information_schema.columns "
                    "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                    (schema, table),
                )
                rows = cur.fetchall()
            nodes = [
                ExplorerNode(
                    id=f"mysql:{database}/{schema}/{table}/{row[0]}",
                    label=row[0],
                    type="column",
                    children_hint="leaf",
                    resource={"database": database, "schema": schema, "table": table, "column": row[0]},
                    metadata={"dataType": row[1], "nullable": row[2] == "YES"},
                )
                for row in rows
            ]
            return ExplorerResponse(nodes=nodes)
        finally:
            conn.close()

    def resolve(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        resource_selector: Dict[str, Any],
    ) -> Dict[str, Any]:
        effective = dict(connector_config)
        if "database" in resource_selector:
            effective["database"] = resource_selector["database"]
        if "schema" in resource_selector:
            effective["schema"] = resource_selector["schema"]
        if "table" in resource_selector:
            effective["table"] = resource_selector["table"]
        return effective
