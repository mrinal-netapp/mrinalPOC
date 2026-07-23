"""Redash HTTP API client with retry/backoff, pagination, and result size cap."""
from observability_client_runtime import get_logger
import os
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

logger = get_logger()

_MAX_RETRIES = 3
_BACKOFF_BASE = 0.5  # seconds; sequence: 0.5, 1.0, 2.0


class RedashAuthError(Exception):
    """Raised when Redash returns 401 (invalid or expired API key)."""


class RedashAPIError(Exception):
    """Raised for non-retryable Redash API errors."""


def _resolve_ca_bundle() -> Optional[str]:
    """Return the CA bundle path if configured, else None (use system default)."""
    for var in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "CURL_CA_BUNDLE"):
        path = os.environ.get(var)
        if path and os.path.isfile(path):
            return path
    return None


class RedashClient:
    """Thin wrapper around the Redash REST API.

    Handles:
    - Auth via ``Authorization: Key <api_key>`` header
    - Retry with exponential backoff on 429 / 5xx
    - Pagination for list endpoints
    - Result size cap to prevent OOM on large cached query results
    - Custom CA bundle via REQUESTS_CA_BUNDLE / SSL_CERT_FILE env vars
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        max_result_rows: int = 10_000,
        verify_tls: bool = True,
    ):
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._max_result_rows = max_result_rows
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Key {api_key}",
            "Content-Type": "application/json",
        })

        if not verify_tls:
            self._session.verify = False
            logger.info("RedashClient TLS verification DISABLED by connector config")
        else:
            ca_bundle = _resolve_ca_bundle()
            if ca_bundle:
                self._session.verify = ca_bundle
                logger.info("RedashClient using custom CA bundle: %s", ca_bundle)
            else:
                logger.info("RedashClient using system default CA certificates")

        parsed = urlparse(self._base_url)
        logger.info(
            "RedashClient initialized: host=%s scheme=%s port=%s verify=%s",
            parsed.hostname, parsed.scheme,
            parsed.port or ("443" if parsed.scheme == "https" else "80"),
            self._session.verify,
        )

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        timeout: int = 30,
    ) -> requests.Response:
        url = f"{self._base_url}{path}"
        last_exc: Optional[Exception] = None
        for attempt in range(_MAX_RETRIES):
            try:
                logger.info(
                    "Redash request: %s %s (attempt %d/%d, verify=%s)",
                    method, url, attempt + 1, _MAX_RETRIES, self._session.verify,
                )
                resp = self._session.request(method, url, params=params, json=json_body, timeout=timeout)
                logger.info(
                    "Redash response: %s %s -> HTTP %d (%d bytes)",
                    method, url, resp.status_code, len(resp.content),
                )
                if resp.status_code == 401:
                    raise RedashAuthError(
                        f"Invalid API key (HTTP 401) from {self._base_url}"
                    )
                if resp.status_code == 404:
                    return resp
                if resp.status_code == 429 or resp.status_code >= 500:
                    wait = _BACKOFF_BASE * (2 ** attempt)
                    logger.warning(
                        "Redash %s %s returned %d, retrying in %.1fs (attempt %d/%d)",
                        method, path, resp.status_code, wait, attempt + 1, _MAX_RETRIES,
                    )
                    time.sleep(wait)
                    last_exc = RedashAPIError(
                        f"HTTP {resp.status_code} from {method} {path}"
                    )
                    continue
                resp.raise_for_status()
                return resp
            except requests.exceptions.SSLError as exc:
                logger.error(
                    "Redash %s %s SSL/TLS error (attempt %d/%d): %s | "
                    "verify=%s, REQUESTS_CA_BUNDLE=%s, SSL_CERT_FILE=%s",
                    method, url, attempt + 1, _MAX_RETRIES, exc,
                    self._session.verify,
                    os.environ.get("REQUESTS_CA_BUNDLE", "<unset>"),
                    os.environ.get("SSL_CERT_FILE", "<unset>"),
                )
                last_exc = exc
                break  # TLS errors are not transient; don't retry
            except (requests.ConnectionError, requests.Timeout) as exc:
                wait = _BACKOFF_BASE * (2 ** attempt)
                logger.warning(
                    "Redash %s %s connection error (attempt %d/%d), retrying in %.1fs: %s",
                    method, url, attempt + 1, _MAX_RETRIES, wait, exc,
                )
                time.sleep(wait)
                last_exc = exc
        raise RedashAPIError(
            f"Failed after {_MAX_RETRIES} attempts: {last_exc}"
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def test_connection(self) -> Dict[str, Any]:
        """Verify connectivity and API key validity."""
        resp = self._request("GET", "/api/queries", params={"page_size": 1})
        resp.raise_for_status()
        return {"ok": True}

    def list_queries(self) -> List[Dict[str, Any]]:
        """Fetch all queries with pagination."""
        return self._paginate("/api/queries", key="results")

    def get_query(self, query_id: int) -> Optional[Dict[str, Any]]:
        """Fetch a single query definition."""
        resp = self._request("GET", f"/api/queries/{query_id}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    def get_query_result(self, query_id: int) -> Optional[Dict[str, Any]]:
        """Fetch the latest cached result for a query.

        Returns None if:
        - No cached result exists (404)
        - The result exceeds max_result_rows
        """
        resp = self._request("GET", f"/api/queries/{query_id}/results.json")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        data = resp.json()
        query_result = data.get("query_result", {})
        rows = query_result.get("data", {}).get("rows", [])
        if len(rows) > self._max_result_rows:
            logger.info(
                "Skipping result for query %d: %d rows exceeds cap %d",
                query_id, len(rows), self._max_result_rows,
            )
            return None
        return query_result

    def execute_query(
        self,
        query_id: int,
        parameters: Optional[Dict[str, Any]] = None,
        max_age: int = 0,
        poll_interval: float = 2.0,
        poll_timeout: float = 600.0,
        heartbeat: Optional[Any] = None,
    ) -> Optional[Dict[str, Any]]:
        """Run a query and return its result rows/columns.

        Posts to ``/api/queries/{id}/results`` which either returns a cached result
        immediately (when ``max_age`` is satisfied) or returns a job id to poll. The
        worker polls ``/api/jobs/{job_id}`` until the job reaches a terminal status
        (3 = done, 4 = failed) or ``poll_timeout`` elapses. On success it fetches the
        ``query_result`` body and returns it (subject to ``max_result_rows`` cap).

        ``max_age=0`` forces a fresh execution; pass a positive value (seconds) to
        accept a cached result up to that age.
        """
        body: Dict[str, Any] = {"max_age": max_age}
        if parameters:
            body["parameters"] = parameters

        resp = self._request("POST", f"/api/queries/{query_id}/results", json_body=body)
        if resp.status_code == 404:
            logger.warning("execute_query %d: 404 from POST /api/queries/{id}/results", query_id)
            return None
        resp.raise_for_status()
        body_json = resp.json() or {}

        # Inline result (cache hit)
        if "query_result" in body_json:
            qr = body_json["query_result"] or {}
            rows = (qr.get("data") or {}).get("rows", [])
            if len(rows) > self._max_result_rows:
                logger.info(
                    "execute_query %d: %d rows exceeds cap %d",
                    query_id, len(rows), self._max_result_rows,
                )
                return None
            return qr

        # Async path — poll the job
        job = body_json.get("job") or {}
        job_id = job.get("id")
        if not job_id:
            logger.warning("execute_query %d: no query_result and no job in response: %s", query_id, body_json)
            return None

        logger.info("execute_query %d: polling job %s", query_id, job_id)
        deadline = time.monotonic() + poll_timeout
        query_result_id: Optional[int] = None
        while time.monotonic() < deadline:
            if callable(heartbeat):
                try:
                    heartbeat(f"redash-job-{job_id}")
                except Exception:
                    pass
            jr = self._request("GET", f"/api/jobs/{job_id}")
            jr.raise_for_status()
            j = (jr.json() or {}).get("job") or {}
            status = j.get("status")
            if status == 3:
                query_result_id = j.get("query_result_id")
                break
            if status == 4:
                error = j.get("error", "unknown error")
                raise RedashAPIError(f"Redash query {query_id} failed: {error}")
            time.sleep(poll_interval)

        if query_result_id is None:
            raise RedashAPIError(f"Redash query {query_id} timed out after {poll_timeout}s")

        rr = self._request("GET", f"/api/query_results/{query_result_id}.json")
        rr.raise_for_status()
        qr = (rr.json() or {}).get("query_result") or {}
        rows = (qr.get("data") or {}).get("rows", [])
        if len(rows) > self._max_result_rows:
            logger.info(
                "execute_query %d: %d rows exceeds cap %d",
                query_id, len(rows), self._max_result_rows,
            )
            return None
        return qr

    def list_dashboards(self) -> List[Dict[str, Any]]:
        """Fetch all dashboards with pagination."""
        return self._paginate("/api/dashboards", key="results")

    def get_dashboard(self, slug: str) -> Optional[Dict[str, Any]]:
        """Fetch a single dashboard with its widgets."""
        resp = self._request("GET", f"/api/dashboards/{slug}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    def list_data_sources(self) -> List[Dict[str, Any]]:
        """Fetch all data source configurations (not paginated)."""
        resp = self._request("GET", "/api/data_sources")
        resp.raise_for_status()
        return resp.json()

    def get_data_source_schema(
        self,
        data_source_id: int,
        refresh: bool = False,
        poll_interval: float = 1.0,
        poll_timeout: float = 60.0,
        heartbeat: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        """Return the schema (tables + columns) for a Redash data source.

        Returns a list of ``{"name": "<table>", "columns": [...]}``. Newer Redash
        builds may answer the synchronous endpoint with ``{"job": {...}}``; in that
        case this polls ``/api/jobs/{id}`` and re-fetches on completion.
        ``refresh=True`` asks Redash to re-discover the schema first (best effort).
        """
        if refresh:
            try:
                self._request("POST", f"/api/data_sources/{data_source_id}/schema/refresh")
            except RedashAPIError as exc:
                logger.info(
                    "Redash schema refresh not available for data source %d: %s",
                    data_source_id, exc,
                )

        params = {"refresh": "true"} if refresh else None
        resp = self._request("GET", f"/api/data_sources/{data_source_id}/schema", params=params)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        body = resp.json() or {}

        if "schema" in body:
            return body.get("schema") or []

        job = body.get("job") or {}
        job_id = job.get("id")
        if not job_id:
            return []

        deadline = time.monotonic() + poll_timeout
        while time.monotonic() < deadline:
            if callable(heartbeat):
                try:
                    heartbeat(f"redash-schema-job-{job_id}")
                except Exception:
                    pass
            jr = self._request("GET", f"/api/jobs/{job_id}")
            jr.raise_for_status()
            j = (jr.json() or {}).get("job") or {}
            status = j.get("status")
            if status == 3:
                break
            if status == 4:
                error = j.get("error", "unknown error")
                raise RedashAPIError(
                    f"Schema discovery for data source {data_source_id} failed: {error}"
                )
            time.sleep(poll_interval)
        else:
            raise RedashAPIError(
                f"Schema discovery for data source {data_source_id} timed out after {poll_timeout}s"
            )

        rr = self._request("GET", f"/api/data_sources/{data_source_id}/schema")
        rr.raise_for_status()
        return (rr.json() or {}).get("schema") or []

    def execute_sql(
        self,
        data_source_id: int,
        sql: str,
        max_age: int = 0,
        parameters: Optional[Dict[str, Any]] = None,
        poll_interval: float = 2.0,
        poll_timeout: float = 600.0,
        heartbeat: Optional[Any] = None,
    ) -> Optional[Dict[str, Any]]:
        """Execute ad-hoc SQL against a Redash data source.

        Posts to ``/api/query_results``; same async-job-or-inline-result flow as
        :py:meth:`execute_query`. Returns the ``query_result`` body (with
        ``data.columns`` and ``data.rows``) or ``None`` if the row cap is exceeded.
        """
        body: Dict[str, Any] = {
            "data_source_id": int(data_source_id),
            "query": sql,
            "max_age": max_age,
        }
        if parameters:
            body["parameters"] = parameters

        resp = self._request("POST", "/api/query_results", json_body=body)
        resp.raise_for_status()
        body_json = resp.json() or {}

        if "query_result" in body_json:
            qr = body_json["query_result"] or {}
            rows = (qr.get("data") or {}).get("rows", [])
            if len(rows) > self._max_result_rows:
                logger.info(
                    "execute_sql ds=%d: %d rows exceeds cap %d",
                    data_source_id, len(rows), self._max_result_rows,
                )
                return None
            return qr

        job = body_json.get("job") or {}
        job_id = job.get("id")
        if not job_id:
            logger.warning("execute_sql ds=%d: no result and no job: %s", data_source_id, body_json)
            return None

        logger.info("execute_sql ds=%d: polling job %s", data_source_id, job_id)
        deadline = time.monotonic() + poll_timeout
        query_result_id: Optional[int] = None
        while time.monotonic() < deadline:
            if callable(heartbeat):
                try:
                    heartbeat(f"redash-sql-job-{job_id}")
                except Exception:
                    pass
            jr = self._request("GET", f"/api/jobs/{job_id}")
            jr.raise_for_status()
            j = (jr.json() or {}).get("job") or {}
            status = j.get("status")
            if status == 3:
                query_result_id = j.get("query_result_id")
                break
            if status == 4:
                error = j.get("error", "unknown error")
                raise RedashAPIError(f"Redash ad-hoc query failed: {error}")
            time.sleep(poll_interval)

        if query_result_id is None:
            raise RedashAPIError(f"Redash ad-hoc query timed out after {poll_timeout}s")

        rr = self._request("GET", f"/api/query_results/{query_result_id}.json")
        rr.raise_for_status()
        qr = (rr.json() or {}).get("query_result") or {}
        rows = (qr.get("data") or {}).get("rows", [])
        if len(rows) > self._max_result_rows:
            logger.info(
                "execute_sql ds=%d: %d rows exceeds cap %d",
                data_source_id, len(rows), self._max_result_rows,
            )
            return None
        return qr

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _paginate(
        self, path: str, key: str = "results", page_size: int = 250
    ) -> List[Dict[str, Any]]:
        """Generic pagination: fetches pages until result count < page_size."""
        all_items: List[Dict[str, Any]] = []
        page = 1
        while True:
            resp = self._request(
                "GET", path, params={"page": page, "page_size": page_size}
            )
            resp.raise_for_status()
            body = resp.json()
            items = body.get(key, []) if isinstance(body, dict) else body
            if not items:
                break
            all_items.extend(items)
            if len(items) < page_size:
                break
            page += 1
        return all_items
