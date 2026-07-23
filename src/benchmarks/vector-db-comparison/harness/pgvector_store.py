"""PostgreSQL + pgvector implementation."""

import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Iterator, Optional

import numpy as np
import psutil
import psycopg2
import psycopg2.extras
from pgvector.psycopg2 import register_vector

from harness.base import (
    BackupMetrics,
    InsertMetrics,
    SearchResult,
    SearchResults,
    VectorStore,
    VersionSwitchMetrics,
)

logger = logging.getLogger(__name__)

RRF_K = 60


class PgvectorStore(VectorStore):
    """pgvector on PostgreSQL with full SQL capabilities."""

    def __init__(
        self,
        host: str = "localhost",
        port: int = 5432,
        database: str = "vectorbench",
        user: str = "benchuser",
        password: str = "benchpass",
    ):
        self._conn_params = {
            "host": host,
            "port": port,
            "dbname": database,
            "user": user,
            "password": password,
        }
        self._conn = None
        self._table_name: Optional[str] = None
        self._dimension: int = 0
        self._metric: str = "cosine"
        self._versions: dict[str, str] = {}
        self._current_version: Optional[str] = None
        self._ivfflat_probes: Optional[int] = None

    def _connect(self):
        if self._conn is None or self._conn.closed:
            self._conn = psycopg2.connect(**self._conn_params)
            self._conn.autocommit = True
            register_vector(self._conn)

    def _execute(self, sql: str, params=None, fetch: bool = False):
        self._connect()
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            if fetch:
                return cur.fetchall()

    def _active_table(self) -> str:
        return self._current_version or self._table_name

    def _distance_op(self) -> str:
        ops = {"cosine": "<=>", "l2": "<->", "ip": "<#>"}
        return ops.get(self._metric, "<=>")

    def _distance_ops_class(self) -> str:
        ops = {
            "cosine": "vector_cosine_ops",
            "l2": "vector_l2_ops",
            "ip": "vector_ip_ops",
        }
        return ops.get(self._metric, "vector_cosine_ops")

    def create_collection(self, name: str, dimension: int, metric: str = "cosine") -> None:
        self._table_name = name
        self._dimension = dimension
        self._metric = metric
        self._ivfflat_probes = None
        self._connect()
        self._execute("CREATE EXTENSION IF NOT EXISTS vector")
        self._execute(f"DROP TABLE IF EXISTS {name} CASCADE")
        self._execute(f"""
            CREATE TABLE {name} (
                id BIGINT PRIMARY KEY,
                vector vector({dimension}),
                text TEXT,
                metadata JSONB DEFAULT '{{}}'::jsonb,
                category TEXT
            )
        """)
        self._current_version = name
        self._versions[name] = name

    def create_index(self, index_type: str, **params) -> float:
        table = self._active_table()
        start = time.perf_counter()
        ops_class = self._distance_ops_class()

        if index_type == "flat":
            self._ivfflat_probes = None
        elif index_type == "ivfflat":
            lists = params.get("lists", 100)
            self._ivfflat_probes = int(params.get("probes", 10))
            self._execute(f"""
                CREATE INDEX ON {table}
                USING ivfflat (vector {ops_class})
                WITH (lists = {lists})
            """)
        elif index_type == "hnsw":
            self._ivfflat_probes = None
            m = params.get("m", 16)
            ef_construction = params.get("ef_construction", 64)
            self._execute(f"""
                CREATE INDEX ON {table}
                USING hnsw (vector {ops_class})
                WITH (m = {m}, ef_construction = {ef_construction})
            """)
        else:
            self._ivfflat_probes = None
            logger.warning("Unknown index type %s", index_type)

        self._execute(f"""
            CREATE INDEX IF NOT EXISTS {table}_text_fts
            ON {table} USING gin (to_tsvector('english', text))
        """)

        elapsed = time.perf_counter() - start
        return elapsed

    def insert(self, vectors, metadata: list[dict], texts: list[str]) -> InsertMetrics:
        mem_before = psutil.Process().memory_info().rss
        start = time.perf_counter()
        table = self._active_table()

        self._connect()
        with self._conn.cursor() as cur:
            values = []
            for i, (vec, meta, text) in enumerate(zip(vectors, metadata, texts)):
                row_id = meta.get("id", i)
                category = meta.get("category", "")
                vec_list = vec.tolist() if hasattr(vec, "tolist") else list(vec)
                meta_clean = {k: v for k, v in meta.items() if k not in ("id", "category")}
                values.append((row_id, vec_list, text, json.dumps(meta_clean), category))

            psycopg2.extras.execute_values(
                cur,
                f"INSERT INTO {table} (id, vector, text, metadata, category) VALUES %s "
                f"ON CONFLICT (id) DO UPDATE SET vector=EXCLUDED.vector, text=EXCLUDED.text, "
                f"metadata=EXCLUDED.metadata, category=EXCLUDED.category",
                values,
                template="(%s, %s::vector, %s, %s::jsonb, %s)",
                page_size=1000,
            )

        elapsed = time.perf_counter() - start
        mem_after = psutil.Process().memory_info().rss
        count = len(vectors)
        return InsertMetrics(
            count=count,
            elapsed_seconds=elapsed,
            vectors_per_second=count / elapsed if elapsed > 0 else 0,
            peak_memory_mb=(mem_after - mem_before) / (1024 * 1024),
        )

    def insert_batch(self, batches: Iterator, total_count: int) -> InsertMetrics:
        mem_before = psutil.Process().memory_info().rss
        start = time.perf_counter()
        inserted = 0
        table = self._active_table()

        self._connect()
        for batch_vectors, batch_metadata, batch_texts in batches:
            with self._conn.cursor() as cur:
                values = []
                for i, (vec, meta, text) in enumerate(
                    zip(batch_vectors, batch_metadata, batch_texts)
                ):
                    row_id = meta.get("id", inserted + i)
                    category = meta.get("category", "")
                    vec_list = vec.tolist() if hasattr(vec, "tolist") else list(vec)
                    meta_clean = {k: v for k, v in meta.items() if k not in ("id", "category")}
                    values.append((row_id, vec_list, text, json.dumps(meta_clean), category))

                psycopg2.extras.execute_values(
                    cur,
                    f"INSERT INTO {table} (id, vector, text, metadata, category) VALUES %s "
                    f"ON CONFLICT (id) DO UPDATE SET vector=EXCLUDED.vector, text=EXCLUDED.text, "
                    f"metadata=EXCLUDED.metadata, category=EXCLUDED.category",
                    values,
                    template="(%s, %s::vector, %s, %s::jsonb, %s)",
                    page_size=1000,
                )
            inserted += len(batch_vectors)

        elapsed = time.perf_counter() - start
        mem_after = psutil.Process().memory_info().rss
        return InsertMetrics(
            count=inserted,
            elapsed_seconds=elapsed,
            vectors_per_second=inserted / elapsed if elapsed > 0 else 0,
            peak_memory_mb=(mem_after - mem_before) / (1024 * 1024),
        )

    def vector_search(
        self, query_vector, top_k: int = 10, filters: Optional[dict] = None
    ) -> SearchResults:
        table = self._active_table()
        qvec = query_vector.tolist() if hasattr(query_vector, "tolist") else list(query_vector)
        vec_literal = f"[{','.join(str(v) for v in qvec)}]"
        dist_op = self._distance_op()

        where = ""
        params = []
        if filters:
            clauses = []
            for key, value in filters.items():
                clauses.append(f"{key} = %s")
                params.append(value)
            where = "WHERE " + " AND ".join(clauses)

        sql = f"""
            SELECT id, text, metadata, category,
                   vector {dist_op} '{vec_literal}'::vector AS distance
            FROM {table}
            {where}
            ORDER BY vector {dist_op} '{vec_literal}'::vector
            LIMIT {top_k}
        """

        start = time.perf_counter()
        self._connect()
        with self._conn.cursor() as cur:
            if self._ivfflat_probes is not None:
                cur.execute("SET ivfflat.probes = %s", (self._ivfflat_probes,))
            cur.execute(sql, params)
            rows = cur.fetchall()
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = [
            SearchResult(
                id=row[0],
                score=float(row[4]),
                text=row[1] or "",
                metadata={**(row[2] or {}), "category": row[3]},
            )
            for row in rows
        ]
        return SearchResults(results=results, latency_ms=elapsed_ms)

    def fts_search(self, query_text: str, top_k: int = 10) -> SearchResults:
        table = self._active_table()
        sql = f"""
            SELECT id, text, metadata, category,
                   ts_rank(to_tsvector('english', text), plainto_tsquery('english', %s)) AS score
            FROM {table}
            WHERE to_tsvector('english', text) @@ plainto_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT {top_k}
        """
        start = time.perf_counter()
        self._connect()
        with self._conn.cursor() as cur:
            cur.execute(sql, (query_text, query_text))
            rows = cur.fetchall()
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = [
            SearchResult(
                id=row[0],
                score=float(row[4]),
                text=row[1] or "",
                metadata={**(row[2] or {}), "category": row[3]},
            )
            for row in rows
        ]
        return SearchResults(results=results, latency_ms=elapsed_ms)

    def hybrid_search(self, query_vector, query_text: str, top_k: int = 10) -> SearchResults:
        """RRF-based hybrid search combining vector and FTS results."""
        table = self._active_table()
        qvec = query_vector.tolist() if hasattr(query_vector, "tolist") else list(query_vector)
        vec_literal = f"[{','.join(str(v) for v in qvec)}]"
        dist_op = self._distance_op()

        sql = f"""
            WITH semantic AS (
                SELECT id, text, metadata, category,
                       ROW_NUMBER() OVER (ORDER BY vector {dist_op} '{vec_literal}'::vector) AS rank
                FROM {table}
                ORDER BY vector {dist_op} '{vec_literal}'::vector
                LIMIT {top_k * 2}
            ),
            keyword AS (
                SELECT id, text, metadata, category,
                       ROW_NUMBER() OVER (
                           ORDER BY ts_rank(to_tsvector('english', text),
                                            plainto_tsquery('english', %s)) DESC
                       ) AS rank
                FROM {table}
                WHERE to_tsvector('english', text) @@ plainto_tsquery('english', %s)
                LIMIT {top_k * 2}
            )
            SELECT
                COALESCE(s.id, k.id) AS id,
                COALESCE(s.text, k.text) AS text,
                COALESCE(s.metadata, k.metadata) AS metadata,
                COALESCE(s.category, k.category) AS category,
                (COALESCE(1.0 / ({RRF_K} + s.rank), 0.0) +
                 COALESCE(1.0 / ({RRF_K} + k.rank), 0.0)) AS rrf_score
            FROM semantic s
            FULL OUTER JOIN keyword k ON s.id = k.id
            ORDER BY rrf_score DESC
            LIMIT {top_k}
        """

        start = time.perf_counter()
        self._connect()
        with self._conn.cursor() as cur:
            if self._ivfflat_probes is not None:
                cur.execute("SET ivfflat.probes = %s", (self._ivfflat_probes,))
            cur.execute(sql, (query_text, query_text))
            rows = cur.fetchall()
        elapsed_ms = (time.perf_counter() - start) * 1000

        results = [
            SearchResult(
                id=row[0],
                score=float(row[4]),
                text=row[1] or "",
                metadata={**(row[2] or {}), "category": row[3]},
            )
            for row in rows
        ]
        return SearchResults(results=results, latency_ms=elapsed_ms)

    def count(self) -> int:
        table = self._active_table()
        rows = self._execute(f"SELECT COUNT(*) FROM {table}", fetch=True)
        return rows[0][0] if rows else 0

    def clear_for_reingest(self) -> None:
        self._current_version = self._table_name
        t = self._table_name
        if t:
            self._execute(f"TRUNCATE TABLE {t} RESTART IDENTITY")

    def drop_collection(self) -> None:
        tables: set[str] = set()
        if self._table_name:
            tables.add(self._table_name)
        for t in self._versions.values():
            if t:
                tables.add(t)
        for t in tables:
            self._execute(f"DROP TABLE IF EXISTS {t} CASCADE")
        self._versions.clear()
        self._current_version = None
        self._table_name = None

    def get_index_size_bytes(self) -> int:
        table = self._active_table()
        rows = self._execute(
            "SELECT pg_indexes_size(%s::regclass)",
            (table,),
            fetch=True,
        )
        return rows[0][0] if rows else 0

    def get_memory_usage_bytes(self) -> int:
        return psutil.Process().memory_info().rss

    def create_version(self, version_id: str) -> None:
        """Create a new version by cloning the table."""
        src = self._active_table()
        dst = f"{self._table_name}_{version_id}"
        self._execute(f"DROP TABLE IF EXISTS {dst} CASCADE")
        self._execute(f"CREATE TABLE {dst} (LIKE {src} INCLUDING ALL)")
        self._execute(f"INSERT INTO {dst} SELECT * FROM {src}")
        self._versions[version_id] = dst

    def switch_version(self, version_id: str) -> VersionSwitchMetrics:
        start = time.perf_counter()
        if version_id not in self._versions:
            raise ValueError(f"Version {version_id} not found")

        self._current_version = self._versions[version_id]
        elapsed_ms = (time.perf_counter() - start) * 1000

        rows = self._execute(
            f"SELECT COUNT(*) FROM {self._current_version}", fetch=True
        )
        verified = rows and rows[0][0] > 0

        return VersionSwitchMetrics(
            switch_latency_ms=elapsed_ms,
            version_id=version_id,
            verified_correct=bool(verified),
        )

    def list_versions(self) -> list[str]:
        return list(self._versions.keys())

    def backup(self, target_path: str) -> BackupMetrics:
        """JSONL export (no host pg_dump required). For pg_dump, run inside the DB container."""
        start = time.perf_counter()
        out = target_path if target_path.endswith(".jsonl") else f"{target_path}.jsonl"
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        table = self._active_table()
        self._backup_jsonl(table, out)
        elapsed = time.perf_counter() - start
        p = Path(out)
        size = p.stat().st_size / (1024 * 1024) if p.exists() else 0
        return BackupMetrics(elapsed_seconds=elapsed, size_mb=size, path=str(p))

    def _backup_jsonl(self, table: str, path: str) -> None:
        self._connect()
        with open(path, "w") as f:
            with self._conn.cursor() as cur:
                cur.execute(
                    f"SELECT id, vector::text, text, metadata, category FROM {table} ORDER BY id"
                )
                for row in cur.fetchall():
                    rec = {
                        "id": row[0],
                        "vector": row[1],
                        "text": row[2],
                        "metadata": row[3] or {},
                        "category": row[4],
                    }
                    f.write(json.dumps(rec, default=str) + "\n")

    def restore(self, source_path: str) -> BackupMetrics:
        p = Path(source_path)
        start = time.perf_counter()
        table = self._active_table() or self._table_name
        if not table:
            raise ValueError("No table to restore into")
        if p.suffix == ".jsonl" or str(source_path).endswith(".jsonl"):
            self._restore_jsonl(table, str(p))
        else:
            rsh = shutil.which("pg_restore")
            if not rsh:
                raise OSError("pg_restore not found; use a .jsonl backup from this harness")
            env = os.environ.copy()
            env["PGPASSWORD"] = self._conn_params["password"]
            subprocess.run(
                [
                    rsh,
                    f"--host={self._conn_params['host']}",
                    f"--port={self._conn_params['port']}",
                    f"--username={self._conn_params['user']}",
                    f"--dbname={self._conn_params['dbname']}",
                    "--if-exists",
                    str(p),
                ],
                check=True,
                env=env,
                capture_output=True,
            )

        self._current_version = self._table_name
        self._connect()
        with self._conn.cursor() as cur:
            cur.execute(f"SELECT 1 FROM {self._active_table()} LIMIT 1")
        elapsed = time.perf_counter() - start
        size = p.stat().st_size / (1024 * 1024) if p.exists() else 0
        return BackupMetrics(elapsed_seconds=elapsed, size_mb=size, path=str(p))

    def _restore_jsonl(self, table: str, path: str) -> None:
        self._connect()
        with self._conn.cursor() as cur:
            cur.execute(f"TRUNCATE TABLE {table} RESTART IDENTITY")
        with open(path) as f:
            for line in f:
                if not line.strip():
                    continue
                rec = json.loads(line)
                vtxt = str(rec["vector"]).strip()
                self._execute(
                    f"""INSERT INTO {table} (id, vector, text, metadata, category)
                    VALUES (%s, %s::vector, %s, %s::jsonb, %s)""",
                    (
                        rec["id"],
                        vtxt,
                        rec["text"],
                        json.dumps(rec.get("metadata") or {}),
                        rec.get("category", ""),
                    ),
                )

    def close(self) -> None:
        if self._conn and not self._conn.closed:
            self._conn.close()
        self._conn = None
