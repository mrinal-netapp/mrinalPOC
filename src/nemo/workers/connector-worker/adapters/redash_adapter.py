"""Redash provider adapter for explorer actions."""
from observability_client_runtime import get_logger
from typing import Any, Dict

from activities.redash_client import RedashClient, RedashAuthError, RedashAPIError
from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter

logger = get_logger()


class RedashAdapter(ProviderAdapter):
    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        try:
            client = RedashClient(
                base_url=connector_config.get("base_url", ""),
                api_key=credential.get("api_key", ""),
                max_result_rows=int(connector_config.get("max_result_rows", 10_000)),
                verify_tls=connector_config.get("verify_tls", True) is not False,
            )
            if action == "testConnection":
                client.test_connection()
                return ExplorerResponse(nodes=[])
            elif action == "listRootFolders":
                return self._list_root_folders()
            elif action == "listQueries":
                return self._list_queries(client)
            elif action == "listDashboards":
                return self._list_dashboards(client)
            elif action == "listDataSources":
                return self._list_data_sources(client)
            elif action == "listDataSourceTables":
                return self._list_data_source_tables(client, payload)
            elif action == "describeQuery":
                return self._describe_query(client, payload)
            return ExplorerResponse(
                error=ExplorerError(
                    "UNSUPPORTED_ACTION",
                    f"Action '{action}' not supported by Redash adapter",
                )
            )
        except RedashAuthError as e:
            return ExplorerResponse(
                error=ExplorerError("AUTH_ERROR", str(e))
            )
        except RedashAPIError as e:
            logger.exception("Redash adapter error: action=%s", action)
            return ExplorerResponse(
                error=ExplorerError("PROVIDER_ERROR", str(e))
            )
        except Exception as e:
            logger.exception("Redash adapter unexpected error: action=%s", action)
            return ExplorerResponse(
                error=ExplorerError("PROVIDER_ERROR", str(e))
            )

    def resolve(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        resource_selector: Dict[str, Any],
    ) -> Dict[str, Any]:
        effective = dict(connector_config)
        effective.update(resource_selector)
        return effective

    # ------------------------------------------------------------------
    # Explorer actions
    # ------------------------------------------------------------------

    def _list_root_folders(self) -> ExplorerResponse:
        return ExplorerResponse(nodes=[
            ExplorerNode(
                id="redash:folder/queries",
                label="Queries",
                type="folder",
                children_hint="hasChildren",
                actions=["listQueries"],
            ),
            ExplorerNode(
                id="redash:folder/dashboards",
                label="Dashboards",
                type="folder",
                children_hint="hasChildren",
                actions=["listDashboards"],
            ),
            ExplorerNode(
                id="redash:folder/data_sources",
                label="Data Sources",
                type="folder",
                children_hint="hasChildren",
                actions=["listDataSources"],
            ),
        ])

    def _list_queries(self, client: RedashClient) -> ExplorerResponse:
        queries = client.list_queries()
        nodes = [
            ExplorerNode(
                id=f"redash:query/{q['id']}",
                label=q.get("name", f"Query {q['id']}"),
                type="query",
                children_hint="hasChildren",
                resource={"query_id": q["id"]},
                metadata={
                    "data_source_id": q.get("data_source_id"),
                    "schedule": q.get("schedule"),
                    "created_at": q.get("created_at"),
                    "is_archived": q.get("is_archived", False),
                },
                actions=["describeQuery"],
            )
            for q in queries
            if not q.get("is_archived", False)
        ]
        return ExplorerResponse(nodes=nodes)

    def _list_dashboards(self, client: RedashClient) -> ExplorerResponse:
        dashboards = client.list_dashboards()
        nodes = [
            ExplorerNode(
                id=f"redash:dashboard/{d.get('slug', d.get('id', ''))}",
                label=d.get("name", f"Dashboard {d.get('id', '?')}"),
                type="dashboard",
                children_hint="leaf",
                resource={"dashboard_slug": d.get("slug", "")},
                metadata={
                    "created_at": d.get("created_at"),
                    "is_archived": d.get("is_archived", False),
                },
            )
            for d in dashboards
            if not d.get("is_archived", False)
        ]
        return ExplorerResponse(nodes=nodes)

    def _list_data_sources(self, client: RedashClient) -> ExplorerResponse:
        sources = client.list_data_sources()
        nodes = [
            ExplorerNode(
                id=f"redash:datasource/{s['id']}",
                label=s.get("name", f"Data Source {s['id']}"),
                type="datasource",
                children_hint="hasChildren",
                resource={"data_source_id": s["id"]},
                metadata={
                    "type": s.get("type", ""),
                    "syntax": s.get("syntax", ""),
                },
                actions=["listDataSourceTables"],
            )
            for s in sources
        ]
        return ExplorerResponse(nodes=nodes)

    def _list_data_source_tables(
        self, client: RedashClient, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        ds_id = payload.get("data_source_id")
        if ds_id is None:
            return ExplorerResponse(
                error=ExplorerError(
                    "VALIDATION_ERROR", "data_source_id is required in payload"
                )
            )
        try:
            schema = client.get_data_source_schema(int(ds_id))
        except RedashAPIError as exc:
            logger.exception("listDataSourceTables ds=%s failed", ds_id)
            return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(exc)))

        nodes = []
        for tbl in schema:
            tbl_name = tbl.get("name") or ""
            if not tbl_name:
                continue
            cols = tbl.get("columns") or []
            normalized_cols = [
                c if isinstance(c, str) else (c.get("name") or "")
                for c in cols
            ]
            nodes.append(ExplorerNode(
                id=f"redash:datasource/{ds_id}/table/{tbl_name}",
                label=tbl_name,
                type="table",
                children_hint="leaf",
                resource={"data_source_id": int(ds_id), "table": tbl_name},
                metadata={
                    "columns": [c for c in normalized_cols if c],
                    "column_count": len([c for c in normalized_cols if c]),
                },
            ))
        return ExplorerResponse(nodes=nodes)

    def _describe_query(
        self, client: RedashClient, payload: Dict[str, Any]
    ) -> ExplorerResponse:
        query_id = payload.get("query_id")
        if not query_id:
            return ExplorerResponse(
                error=ExplorerError(
                    "VALIDATION_ERROR", "query_id is required in payload"
                )
            )
        query = client.get_query(int(query_id))
        if query is None:
            return ExplorerResponse(
                error=ExplorerError("NOT_FOUND", f"Query {query_id} not found")
            )
        sql_snippet = (query.get("query", "") or "")[:200]
        nodes = [
            ExplorerNode(
                id=f"redash:query/{query_id}/sql",
                label="SQL",
                type="column",
                children_hint="leaf",
                metadata={"value": sql_snippet},
            ),
        ]
        if query.get("schedule"):
            nodes.append(ExplorerNode(
                id=f"redash:query/{query_id}/schedule",
                label="Schedule",
                type="column",
                children_hint="leaf",
                metadata={"value": str(query["schedule"])},
            ))
        if query.get("data_source_id"):
            nodes.append(ExplorerNode(
                id=f"redash:query/{query_id}/datasource",
                label="Data Source",
                type="column",
                children_hint="leaf",
                metadata={"value": str(query["data_source_id"])},
            ))
        return ExplorerResponse(nodes=nodes)
