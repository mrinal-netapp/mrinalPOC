"""KB retrieval client and agno knowledge_retriever factory.

Provides a thin async HTTP client for the kb-retrieval-service multi-KB
search endpoint and a factory that produces closures compatible with agno's
``knowledge_retriever`` callback signature.

All untrusted text (KB names, descriptions, retrieved chunk content) is
sanitised before being passed to the LLM context to mitigate prompt-injection
attacks.  See ``sanitize.py`` for the full defence-in-depth strategy.
"""

import asyncio
import time
from typing import Any, Callable, Optional

import httpx
from observability_client_runtime import get_logger

from .config import settings
from .sanitize import (
    GUARDRAIL_INSTRUCTIONS,
    sanitize_chunk_content,
    sanitize_chunk_title,
    sanitize_kb_description,
    sanitize_kb_name,
    wrap_kb_data,
)

logger = get_logger()

SEARCH_MODE_MAP: dict[str, str] = {
    "semantic": "vector",
    "hybrid": "hybrid",
    "fts": "fts",
}


class KBRetrievalClient:
    """Async HTTP wrapper around the kb-retrieval-service search API."""

    def __init__(self, http_client: httpx.AsyncClient, base_url: str) -> None:
        self._client = http_client
        self._base_url = base_url.rstrip("/")

    async def search(
        self,
        project_id: str,
        knowledge_base_ids: list[str],
        query: str,
        top_k: int = 10,
        min_score: float = 0.0,
        search_mode: str = "hybrid",
    ) -> list[dict[str, Any]]:
        """Call the multi-KB search endpoint and return the merged results.

        Returns an empty list on any transport or server error so the agent
        can continue without KB context rather than crashing.
        """
        url = f"{self._base_url}/api/v1/projects/{project_id}/knowledgebases/search"
        payload = {
            "query": query,
            "knowledgeBaseIds": knowledge_base_ids,
            "topK": top_k,
            "minScore": min_score,
            "searchMode": search_mode,
            "aggregationStrategy": "merge",
        }
        headers = {"X-Project-ID": project_id}

        logger.info(
            "KB search starting: url=%s project=%s kbs=%s mode=%s topK=%d query_len=%d",
            url, project_id, knowledge_base_ids, search_mode, top_k, len(query),
        )
        t0 = time.monotonic()

        retries = max(0, settings.KB_SEARCH_RETRIES)
        resp: httpx.Response | None = None
        last_exc: Exception | None = None
        for attempt in range(retries + 1):
            try:
                resp = await self._client.post(url, json=payload, headers=headers)
                break
            except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError) as exc:
                last_exc = exc
                logger.warning(
                    "KB search transport error (attempt %d/%d) in %.3fs: project=%s kbs=%s err=%r",
                    attempt + 1,
                    retries + 1,
                    time.monotonic() - t0,
                    project_id,
                    knowledge_base_ids,
                    str(exc) or "(empty)",
                )
                if attempt < retries:
                    # Small linear backoff to smooth transient network hiccups.
                    await asyncio.sleep(0.2 * (attempt + 1))
                    continue
                logger.error(
                    "KB search failed after retries: url=%s project=%s kbs=%s exc_type=%s err=%r",
                    url,
                    project_id,
                    knowledge_base_ids,
                    type(exc).__name__,
                    str(exc) or "(empty)",
                )
                return []
            except httpx.HTTPError as exc:
                last_exc = exc
                logger.error(
                    "KB search failed (http) in %.3fs: url=%s project=%s kbs=%s exc_type=%s err=%r",
                    time.monotonic() - t0, url, project_id, knowledge_base_ids,
                    type(exc).__name__, str(exc) or "(empty)",
                )
                return []

        if resp is None:
            logger.error(
                "KB search failed without response: project=%s kbs=%s err=%r",
                project_id,
                knowledge_base_ids,
                str(last_exc) if last_exc else "(unknown)",
            )
            return []

        elapsed = time.monotonic() - t0

        if resp.status_code != 200:
            body_snippet = resp.text[:300] if resp.text else "(empty)"
            logger.error(
                "KB search returned %d in %.3fs: project=%s kbs=%s body=%s",
                resp.status_code, elapsed, project_id, knowledge_base_ids, body_snippet,
            )
            return []

        try:
            data = resp.json()
        except Exception:
            logger.error("KB search returned invalid JSON in %.3fs: project=%s", elapsed, project_id)
            return []

        results = data.get("results", [])
        logger.info(
            "KB search completed in %.3fs: project=%s kbs=%d results=%d",
            elapsed, project_id, len(knowledge_base_ids), len(results),
        )
        return results


async def fetch_kb_metadata(
    http_client: httpx.AsyncClient,
    config_service_url: str,
    project_id: str,
    kb_ids: list[str],
    auth_headers: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Fetch name/description for each KB from the config-service.

    Returns a list of ``{"id": ..., "name": ..., "description": ...}`` dicts.
    Failures for individual KBs are logged and skipped so the agent still
    works even if metadata is unavailable.
    """
    results: list[dict[str, Any]] = []
    headers = dict(auth_headers) if auth_headers else {}
    for kb_id in kb_ids:
        url = f"{config_service_url}/api/v1/projects/{project_id}/knowledgebases/{kb_id}"
        try:
            resp = await http_client.get(url, headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                results.append({
                    "id": kb_id,
                    "name": sanitize_kb_name(data.get("name", kb_id)),
                    "description": sanitize_kb_description(data.get("description", "")),
                })
            else:
                logger.warning("KB metadata fetch returned %d for %s", resp.status_code, kb_id)
                results.append({"id": kb_id, "name": sanitize_kb_name(kb_id), "description": ""})
        except Exception as exc:
            logger.warning("KB metadata fetch failed for %s: %s", kb_id, exc)
            results.append({"id": kb_id, "name": sanitize_kb_name(kb_id), "description": ""})
    return results


def build_kb_instructions(kb_metadata: list[dict[str, Any]]) -> str:
    """Build a system-prompt snippet describing available knowledge bases.

    Includes:
    - Anti-injection guardrail rules
    - KB descriptions wrapped in ``<kb_data>`` boundary markers
    - Instructions for using the search tool
    """
    kb_listing_lines: list[str] = []
    for kb in kb_metadata:
        desc = f" — {kb['description']}" if kb.get("description") else ""
        kb_listing_lines.append(f"  • {kb['name']}{desc}")
    kb_listing = "\n".join(kb_listing_lines)

    return (
        f"{GUARDRAIL_INSTRUCTIONS}\n\n"
        "You have access to a knowledge base search tool (search_knowledge_base).\n"
        "Always search the knowledge base before answering factual questions — "
        "do not assume you know the answer.\n\n"
        "Available knowledge bases:\n"
        f"{wrap_kb_data(kb_listing)}\n\n"
        "When the user's question may relate to content in these knowledge bases, "
        "use the search tool with a clear, specific query."
    )


def make_kb_retriever(
    client: KBRetrievalClient,
    project_id: str,
    knowledge_base_ids: list[str],
    top_k: int = 10,
    min_score: float = 0.0,
    search_mode: str = "hybrid",
    citations_sink: Optional[list[dict[str, Any]]] = None,
) -> Callable[..., Any]:
    """Create an async ``knowledge_retriever`` closure for agno Agent.

    The returned function has the signature agno expects::

        async def retriever(agent, query, num_documents=None, **kwargs)
            -> Optional[list[dict]]

    ``knowledge_base_ids`` is captured in the closure at construction time,
    guaranteeing the agent can only query its configured KBs.

    If *citations_sink* is provided (a mutable list), raw search results are
    appended so callers can surface source citations to end-users.
    """

    async def retriever(
        agent: Any,
        query: str,
        num_documents: Optional[int] = None,
        **kwargs: Any,
    ) -> Optional[list[dict[str, Any]]]:
        effective_top_k = num_documents or top_k
        logger.info(
            "knowledge_retriever invoked: project=%s kbs=%s query_preview=%.80s topK=%d",
            project_id, knowledge_base_ids, query, effective_top_k,
        )
        results = await client.search(
            project_id=project_id,
            knowledge_base_ids=knowledge_base_ids,
            query=query,
            top_k=effective_top_k,
            min_score=min_score,
            search_mode=search_mode,
        )
        if not results:
            logger.info("knowledge_retriever: no results for project=%s", project_id)
            return None

        logger.info(
            "knowledge_retriever: returning %d docs to agent (top score=%.3f)",
            len(results), results[0].get("score", 0.0) if results else 0.0,
        )

        if citations_sink is not None:
            citations_sink.extend(results)

        return [
            {
                "title": sanitize_chunk_title(r.get("source", "")),
                "content": wrap_kb_data(sanitize_chunk_content(r.get("text", ""))),
                "score": r.get("score"),
                "knowledge_base_id": r.get("knowledgeBaseId"),
            }
            for r in results
        ]

    return retriever


def deduplicate_citations(raw_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate KB results by source document, keeping the highest score."""
    seen: dict[str, dict[str, Any]] = {}
    for r in raw_results:
        source = r.get("source", "")
        if not source:
            continue
        score = r.get("score", 0.0)
        if source not in seen or score > seen[source].get("score", 0.0):
            seen[source] = {
                "source": source,
                "documentId": r.get("documentId") or r.get("document_id", ""),
                "downloadUrl": r.get("downloadUrl") or r.get("download_url"),
                "knowledgeBaseId": r.get("knowledgeBaseId") or r.get("knowledge_base_id", ""),
                "knowledgeBaseName": r.get("knowledgeBaseName") or r.get("knowledge_base_name", ""),
                "score": score,
            }
    return sorted(seen.values(), key=lambda c: c.get("score", 0), reverse=True)
