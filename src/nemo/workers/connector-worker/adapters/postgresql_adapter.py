"""PostgreSQL provider adapter for explorer actions. Uses native psycopg2 driver."""
from observability_client_runtime import get_logger
from typing import Any, Dict

from activities.db_connection import connect_postgres

from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter

logger = get_logger()


def _effective_db(config: Dict[str, Any], payload: Dict[str, Any]) -> str:
    """Database to use: payload (when browsing from listDatabases) or connector config."""
    return (payload.get("database") or config.get("database") or "postgres").strip() or "postgres"


def _config_for_db(config: Dict[str, Any], database: str) -> Dict[str, Any]:
    """Config overlay to connect to the given database."""
    out = dict(config)
    out["database"] = database
    return out


class PostgreSQLAdapter(ProviderAdapter):
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
                error=ExplorerError("UNSUPPORTED_ACTION", f"Action '{action}' not supported by PostgreSQL adapter"),
            )
        except Exception as e:
            logger.exception("PostgreSQL adapter error: action=%s", action)
            return ExplorerResponse(
                error=ExplorerError("PROVIDER_ERROR", str(e)),
            )

    def _list_databases(
        self,
        config: Dict[str, Any],
        creds: Dict[str, str],
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        # Connect to default DB to list databases
        conn = connect_postgres(config, creds, 30000)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
                )
                rows = cur.fetchall()
            nodes = [
                ExplorerNode(
                    id=f"pg:db/{row[0]}",
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
        cfg = _config_for_db(config, database)
        conn = connect_postgres(cfg, creds, 30000)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT schema_name FROM information_schema.schemata "
                    "WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast') "
                    "ORDER BY schema_name"
                )
                rows = cur.fetchall()
            nodes = [
                ExplorerNode(
                    id=f"pg:{database}/{row[0]}",
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
        schema = payload.get("schema") or config.get("schema", "public")
        cfg = _config_for_db(config, database)
        conn = connect_postgres(cfg, creds, 30000)
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
                    id=f"pg:{database}/{schema}/{row[0]}",
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
        schema = payload.get("schema") or config.get("schema", "public")
        table = payload.get("table")
        if not table:
            return ExplorerResponse(
                error=ExplorerError("VALIDATION_ERROR", "table is required in payload for describeTable"),
            )
        cfg = _config_for_db(config, database)
        conn = connect_postgres(cfg, creds, 30000)
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
                    id=f"pg:{database}/{schema}/{table}/{row[0]}",
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
