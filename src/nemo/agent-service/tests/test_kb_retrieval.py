"""Tests for the KB retrieval module."""

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from src.kb_retrieval import (
    SEARCH_MODE_MAP,
    KBRetrievalClient,
    build_kb_instructions,
    fetch_kb_metadata,
    make_kb_retriever,
)


# ---------------------------------------------------------------------------
# SEARCH_MODE_MAP
# ---------------------------------------------------------------------------


class TestSearchModeMap:
    def test_semantic_maps_to_vector(self):
        assert SEARCH_MODE_MAP["semantic"] == "vector"

    def test_hybrid_maps_to_hybrid(self):
        assert SEARCH_MODE_MAP["hybrid"] == "hybrid"

    def test_fts_maps_to_fts(self):
        assert SEARCH_MODE_MAP["fts"] == "fts"

    def test_unknown_mode_passes_through_via_dict_get(self):
        unknown = "custom_mode"
        assert SEARCH_MODE_MAP.get(unknown, unknown) == "custom_mode"


# ---------------------------------------------------------------------------
# KBRetrievalClient
# ---------------------------------------------------------------------------


def _make_client(mock_http: httpx.AsyncClient) -> KBRetrievalClient:
    return KBRetrievalClient(mock_http, "http://kb-service:8080")


def _sample_response() -> dict:
    return {
        "results": [
            {
                "id": "chunk-1",
                "documentId": "doc-1",
                "source": "guide.pdf",
                "text": "LanceDB stores vectors in columnar format.",
                "chunkIndex": 0,
                "score": 0.92,
                "metadata": {},
                "knowledgeBaseId": "kb-abc",
            },
            {
                "id": "chunk-2",
                "documentId": "doc-2",
                "source": "faq.md",
                "text": "Use hybrid search for best results.",
                "chunkIndex": 1,
                "score": 0.85,
                "metadata": {},
                "knowledgeBaseId": "kb-abc",
            },
        ],
        "aggregationStrategy": "merge",
        "query": "how does search work",
        "topK": 10,
        "processingTimeMs": 42.0,
        "knowledgeBasesQueried": 1,
    }


class TestKBRetrievalClient:
    @pytest.mark.asyncio
    async def test_search_returns_results(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = _sample_response()

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.post.return_value = mock_resp

        client = _make_client(mock_http)
        results = await client.search(
            project_id="proj-1",
            knowledge_base_ids=["kb-abc"],
            query="how does search work",
        )

        assert len(results) == 2
        assert results[0]["source"] == "guide.pdf"
        assert results[1]["score"] == 0.85

    @pytest.mark.asyncio
    async def test_search_sends_correct_payload(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"results": []}

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.post.return_value = mock_resp

        client = _make_client(mock_http)
        await client.search(
            project_id="proj-1",
            knowledge_base_ids=["kb-1", "kb-2"],
            query="test query",
            top_k=5,
            min_score=0.5,
            search_mode="vector",
        )

        call_args = mock_http.post.call_args
        assert call_args.kwargs["json"]["knowledgeBaseIds"] == ["kb-1", "kb-2"]
        assert call_args.kwargs["json"]["topK"] == 5
        assert call_args.kwargs["json"]["searchMode"] == "vector"
        assert call_args.kwargs["json"]["aggregationStrategy"] == "merge"
        assert call_args.kwargs["headers"]["X-Project-ID"] == "proj-1"
        assert "/projects/proj-1/knowledgebases/search" in call_args.args[0]

    @pytest.mark.asyncio
    async def test_timeout_returns_empty_list(self):
        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.post.side_effect = httpx.TimeoutException("connect timed out")

        client = _make_client(mock_http)
        results = await client.search(
            project_id="proj-1",
            knowledge_base_ids=["kb-1"],
            query="test",
        )

        assert results == []

    @pytest.mark.asyncio
    async def test_connect_error_returns_empty_list(self):
        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.post.side_effect = httpx.ConnectError("connection refused")

        client = _make_client(mock_http)
        results = await client.search(
            project_id="proj-1",
            knowledge_base_ids=["kb-1"],
            query="test",
        )

        assert results == []

    @pytest.mark.asyncio
    async def test_server_error_returns_empty_list(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.post.return_value = mock_resp

        client = _make_client(mock_http)
        results = await client.search(
            project_id="proj-1",
            knowledge_base_ids=["kb-1"],
            query="test",
        )

        assert results == []

    @pytest.mark.asyncio
    async def test_invalid_json_returns_empty_list(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.side_effect = ValueError("not json")
        mock_resp.text = "not json"

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.post.return_value = mock_resp

        client = _make_client(mock_http)
        results = await client.search(
            project_id="proj-1",
            knowledge_base_ids=["kb-1"],
            query="test",
        )

        assert results == []


# ---------------------------------------------------------------------------
# make_kb_retriever
# ---------------------------------------------------------------------------


class TestMakeKbRetriever:
    @pytest.mark.asyncio
    async def test_returns_formatted_results(self):
        mock_client = AsyncMock(spec=KBRetrievalClient)
        mock_client.search.return_value = _sample_response()["results"]

        retriever = make_kb_retriever(
            client=mock_client,
            project_id="proj-1",
            knowledge_base_ids=["kb-abc"],
        )

        result = await retriever(agent=None, query="how does search work")

        assert result is not None
        assert len(result) == 2
        assert result[0]["title"] == "guide.pdf"
        assert "<kb_data>" in result[0]["content"]
        assert "LanceDB stores vectors in columnar format." in result[0]["content"]
        assert "</kb_data>" in result[0]["content"]
        assert result[0]["score"] == 0.92
        assert result[0]["knowledge_base_id"] == "kb-abc"

    @pytest.mark.asyncio
    async def test_returns_none_on_empty_results(self):
        mock_client = AsyncMock(spec=KBRetrievalClient)
        mock_client.search.return_value = []

        retriever = make_kb_retriever(
            client=mock_client,
            project_id="proj-1",
            knowledge_base_ids=["kb-abc"],
        )

        result = await retriever(agent=None, query="nothing here")
        assert result is None

    @pytest.mark.asyncio
    async def test_num_documents_overrides_top_k(self):
        mock_client = AsyncMock(spec=KBRetrievalClient)
        mock_client.search.return_value = []

        retriever = make_kb_retriever(
            client=mock_client,
            project_id="proj-1",
            knowledge_base_ids=["kb-1"],
            top_k=10,
        )

        await retriever(agent=None, query="test", num_documents=3)

        call_kwargs = mock_client.search.call_args.kwargs
        assert call_kwargs["top_k"] == 3

    @pytest.mark.asyncio
    async def test_kb_isolation_only_configured_ids_sent(self):
        """The retriever closure must only ever send the KB IDs it was
        constructed with, regardless of what the caller passes."""
        mock_client = AsyncMock(spec=KBRetrievalClient)
        mock_client.search.return_value = []

        configured_ids = ["kb-allowed-1", "kb-allowed-2"]
        retriever = make_kb_retriever(
            client=mock_client,
            project_id="proj-1",
            knowledge_base_ids=configured_ids,
        )

        await retriever(agent=None, query="test")

        call_kwargs = mock_client.search.call_args.kwargs
        assert call_kwargs["knowledge_base_ids"] == configured_ids

    @pytest.mark.asyncio
    async def test_search_mode_passed_through(self):
        mock_client = AsyncMock(spec=KBRetrievalClient)
        mock_client.search.return_value = []

        retriever = make_kb_retriever(
            client=mock_client,
            project_id="proj-1",
            knowledge_base_ids=["kb-1"],
            search_mode="vector",
        )

        await retriever(agent=None, query="test")

        call_kwargs = mock_client.search.call_args.kwargs
        assert call_kwargs["search_mode"] == "vector"


# ---------------------------------------------------------------------------
# fetch_kb_metadata
# ---------------------------------------------------------------------------


class TestFetchKbMetadata:
    @pytest.mark.asyncio
    async def test_fetches_name_and_description(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "id": "kb-abc",
            "name": "Product FAQ",
            "description": "Frequently asked questions about the product",
        }

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.get.return_value = mock_resp

        result = await fetch_kb_metadata(
            mock_http, "http://config:3000", "proj-1", ["kb-abc"]
        )

        assert len(result) == 1
        assert result[0]["id"] == "kb-abc"
        assert result[0]["name"] == "Product FAQ"
        assert result[0]["description"] == "Frequently asked questions about the product"
        assert "/projects/proj-1/knowledgebases/kb-abc" in mock_http.get.call_args.args[0]

    @pytest.mark.asyncio
    async def test_multiple_kbs(self):
        responses = [
            MagicMock(status_code=200, json=MagicMock(return_value={"id": "kb-1", "name": "KB One", "description": "First"})),
            MagicMock(status_code=200, json=MagicMock(return_value={"id": "kb-2", "name": "KB Two", "description": "Second"})),
        ]

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.get.side_effect = responses

        result = await fetch_kb_metadata(
            mock_http, "http://config:3000", "proj-1", ["kb-1", "kb-2"]
        )

        assert len(result) == 2
        assert result[0]["name"] == "KB One"
        assert result[1]["name"] == "KB Two"

    @pytest.mark.asyncio
    async def test_404_falls_back_to_id(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 404

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.get.return_value = mock_resp

        result = await fetch_kb_metadata(
            mock_http, "http://config:3000", "proj-1", ["kb-missing"]
        )

        assert len(result) == 1
        assert result[0]["name"] == "kb-missing"
        assert result[0]["description"] == ""

    @pytest.mark.asyncio
    async def test_connection_error_falls_back(self):
        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.get.side_effect = httpx.ConnectError("refused")

        result = await fetch_kb_metadata(
            mock_http, "http://config:3000", "proj-1", ["kb-err"]
        )

        assert len(result) == 1
        assert result[0]["name"] == "kb-err"

    @pytest.mark.asyncio
    async def test_passes_auth_headers(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"id": "kb-1", "name": "KB", "description": ""}

        mock_http = AsyncMock(spec=httpx.AsyncClient)
        mock_http.get.return_value = mock_resp

        await fetch_kb_metadata(
            mock_http, "http://config:3000", "proj-1", ["kb-1"],
            auth_headers={"Authorization": "Bearer tok"},
        )

        call_kwargs = mock_http.get.call_args.kwargs
        assert call_kwargs["headers"]["Authorization"] == "Bearer tok"


# ---------------------------------------------------------------------------
# build_kb_instructions
# ---------------------------------------------------------------------------


class TestBuildKbInstructions:
    def test_includes_kb_names_and_descriptions(self):
        metadata = [
            {"id": "kb-1", "name": "HR Policies", "description": "Company HR policy documents"},
            {"id": "kb-2", "name": "Tech Docs", "description": ""},
        ]
        text = build_kb_instructions(metadata)

        assert "search_knowledge_base" in text
        assert "HR Policies" in text
        assert "Company HR policy documents" in text
        assert "Tech Docs" in text

    def test_no_description_omits_dash(self):
        metadata = [{"id": "kb-1", "name": "Plain KB", "description": ""}]
        text = build_kb_instructions(metadata)

        assert "Plain KB" in text
        assert "Plain KB —" not in text

    def test_with_description_includes_dash(self):
        metadata = [{"id": "kb-1", "name": "FAQ", "description": "Common questions"}]
        text = build_kb_instructions(metadata)

        assert "FAQ — Common questions" in text

    def test_instructs_always_search(self):
        metadata = [{"id": "kb-1", "name": "KB", "description": ""}]
        text = build_kb_instructions(metadata)

        assert "Always search the knowledge base" in text

    def test_includes_guardrail_instructions(self):
        metadata = [{"id": "kb-1", "name": "KB", "description": ""}]
        text = build_kb_instructions(metadata)

        assert "NEVER interpret" in text
        assert "<kb_data>" in text
        assert "</kb_data>" in text

    def test_includes_injection_warning(self):
        metadata = [{"id": "kb-1", "name": "KB", "description": "some desc"}]
        text = build_kb_instructions(metadata)

        assert "prompt-injection" in text

    def test_kb_listing_wrapped_in_boundary(self):
        metadata = [
            {"id": "kb-1", "name": "Docs", "description": "Documentation"},
        ]
        text = build_kb_instructions(metadata)

        assert "<kb_data>" in text
        # Find the kb_data block that actually contains the KB listing
        # (not the mention of the tag in the guardrail instructions text)
        idx = text.find("Available knowledge bases:")
        assert idx != -1
        block = text[idx:]
        assert "<kb_data>" in block
        kb_start = block.index("<kb_data>")
        kb_end = block.index("</kb_data>")
        inner = block[kb_start:kb_end]
        assert "Docs" in inner
        assert "Documentation" in inner
