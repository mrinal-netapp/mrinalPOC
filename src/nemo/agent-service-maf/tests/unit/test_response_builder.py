"""Unit tests for :class:`ResponseBuilder` (§B1, §B4, §B8 of the migration plan).

Covers (per execution-plan G1):

- Token concatenation into ``output``.
- Tool-call / tool-result aggregation into ``agentTrace[].toolExecutions``.
- KB-citation dedup edge cases:
  * Two distinct chunks of the same document → both appear.
  * Same ``(kbId, docId, chunkId)`` twice → one entry, max score wins.
  * Non-allowlisted tools contribute per-step ``kb_citations`` but **not**
    top-level :attr:`Citations.kb_citations`.
- ``KbCitation.chunk_id`` is **not** serialized on the wire.
- ``parsed_output`` extraction from raw JSON and fenced JSON blocks.
- ``finalize()`` is idempotent (callable more than once).
- ``set_citations()`` wins over the lazy aggregation path.
- Performance breakdown is built from accumulated LLM / tool timings.
"""

from __future__ import annotations

import json

import pytest

from agent_service_maf.core.interfaces import Citations, KbCitation
from agent_service_maf.framework.response_builder import ResponseBuilder, _try_parse_json

# ---------------------------------------------------------------------------
# Token + output aggregation
# ---------------------------------------------------------------------------


class TestTokenAggregation:
    """Tokens fed via :meth:`add_token` concatenate verbatim into ``output``."""

    def test_tokens_concatenate_in_order(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_token("Hi")
        builder.add_token(" there")
        builder.add_token("!")
        resp = builder.finalize()
        assert resp.output == "Hi there!", f"Expected 'Hi there!', got {resp.output!r}"

    def test_empty_tokens_ignored(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_token("")
        builder.add_token("hello")
        builder.add_token("")
        resp = builder.finalize()
        assert resp.output == "hello", "Empty token chunks must not introduce holes"

    def test_finalize_is_idempotent(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_token("once")
        first = builder.finalize()
        second = builder.finalize()
        assert first.output == second.output == "once", "finalize() must be re-callable"
        assert first.agent_id == second.agent_id == "echo"


# ---------------------------------------------------------------------------
# Tool execution + trace aggregation
# ---------------------------------------------------------------------------


class TestToolTrace:
    """Tool-call / tool-result events build the agentTrace structure."""

    def test_tool_call_creates_step_lazily(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("call-1", "search", arguments={"q": "x"})
        resp = builder.finalize()
        assert resp.citations is not None, "Tool call must produce a Citations envelope"
        assert len(resp.citations.agent_trace) == 1, "Expected one auto-opened step"
        step = resp.citations.agent_trace[0]
        assert step.agent_name == "echo", "Step defaults to the responding agent id"
        assert len(step.tool_executions) == 1, "Step must contain the tool call"
        execution = step.tool_executions[0]
        assert execution.tool_name == "search"
        assert execution.tool_call_id == "call-1"
        assert execution.arguments == {"q": "x"}

    def test_tool_result_fills_matching_call(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("c1", "search", arguments={"q": "x"})
        builder.add_tool_result("c1", "raw result text", duration_ms=42)
        resp = builder.finalize()
        execution = resp.citations.agent_trace[0].tool_executions[0]
        assert execution.result_summary == "raw result text", "Result text propagates"
        assert execution.duration_ms == 42, "Duration propagates"

    def test_tool_result_long_result_truncated_to_200_chars(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("c1", "search")
        long_result = "x" * 500
        builder.add_tool_result("c1", long_result)
        execution = builder.finalize().citations.agent_trace[0].tool_executions[0]
        assert len(execution.result_summary) == 200, "Result summary must cap at 200 chars"

    def test_tool_result_with_unknown_call_id_is_ignored(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_result("never-emitted", "stuff")
        resp = builder.finalize()
        assert resp.citations is None, "No step opened => no citations envelope"

    def test_explicit_step_per_agent(self) -> None:
        builder = ResponseBuilder(agent_id="team-manager")
        idx_a = builder.open_step(agent_name="ontap-specialist", action="respond")
        idx_b = builder.open_step(agent_name="netapp-specialist", action="respond")
        builder.add_tool_call("c1", "search", agent_name="ontap-specialist")
        builder.add_tool_call("c2", "kb_search", agent_name="netapp-specialist")
        resp = builder.finalize()
        assert idx_a == 0 and idx_b == 1
        trace = resp.citations.agent_trace
        assert len(trace) == 2, "Expected two trace steps"
        # add_tool_call uses the most recent open step; both calls land on idx_b
        # That's documented behaviour - explicit step opening only changes the
        # default target for subsequent calls.
        assert len(trace[1].tool_executions) == 2, "Most recent step receives the calls"


# ---------------------------------------------------------------------------
# KB-citation aggregation + dedup
# ---------------------------------------------------------------------------


class TestKbCitationAggregation:
    """Any tool that emits ``kb_citations`` contributes to the top-level
    dedup envelope; the allowlist concept has been removed in favour of
    the :class:`FunctionToolResult` opt-in contract.
    """

    def test_two_distinct_chunks_same_doc_both_kept(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("c1", "kb_search")
        citations = [
            {
                "source": "doc.pdf",
                "documentId": "doc-1",
                "knowledgeBaseId": "kb-1",
                "chunkId": "chunk-a",
                "score": 0.9,
            },
            {
                "source": "doc.pdf",
                "documentId": "doc-1",
                "knowledgeBaseId": "kb-1",
                "chunkId": "chunk-b",
                "score": 0.6,
            },
        ]
        builder.add_tool_result("c1", "ok", kb_citations=citations)
        resp = builder.finalize()
        top_level = resp.citations.kb_citations
        assert len(top_level) == 2, f"Two distinct chunks must both appear, got {len(top_level)}"
        scores = sorted([c.score for c in top_level])
        assert scores == [0.6, 0.9], "Both scores preserved"

    def test_same_chunk_twice_keeps_highest_score(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("c1", "kb_search")
        builder.add_tool_result(
            "c1",
            "ok",
            kb_citations=[
                {
                    "source": "doc.pdf",
                    "documentId": "doc-1",
                    "knowledgeBaseId": "kb-1",
                    "chunkId": "chunk-a",
                    "score": 0.5,
                },
            ],
        )
        builder.add_tool_call("c2", "kb_search")
        builder.add_tool_result(
            "c2",
            "ok",
            kb_citations=[
                {
                    "source": "doc.pdf",
                    "documentId": "doc-1",
                    "knowledgeBaseId": "kb-1",
                    "chunkId": "chunk-a",
                    "score": 0.95,
                },
            ],
        )
        resp = builder.finalize()
        top_level = resp.citations.kb_citations
        assert len(top_level) == 1, "Same key collapsed to one entry"
        assert top_level[0].score == 0.95, "Max score wins on collision"

    def test_any_tool_with_citations_populates_top_level(self) -> None:
        """The allowlist is gone -- any tool that supplies kb_citations
        contributes to top-level dedup, not just the legacy KB tool
        names. Function tools opt in via FunctionToolResult.
        """
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("c1", "some_other_tool")
        builder.add_tool_result(
            "c1",
            "ok",
            kb_citations=[
                {
                    "source": "doc.pdf",
                    "documentId": "doc-1",
                    "knowledgeBaseId": "kb-1",
                    "chunkId": "chunk-a",
                    "score": 0.5,
                },
            ],
        )
        resp = builder.finalize()
        # Top-level surfaces the citation regardless of tool name.
        assert len(resp.citations.kb_citations) == 1
        assert resp.citations.kb_citations[0].source == "doc.pdf"
        # Per-step kbCitations still populated for the trace footer.
        execution = resp.citations.agent_trace[0].tool_executions[0]
        assert execution.kb_citations is not None
        assert len(execution.kb_citations) == 1

    def test_chunk_id_excluded_from_wire(self) -> None:
        """KbCitation.chunk_id is internal dedup state and MUST NOT serialize."""
        citation = KbCitation(
            source="doc.pdf",
            document_id="d1",
            knowledge_base_id="kb1",
            chunk_id="secret-chunk",
            score=0.8,
        )
        wire = citation.model_dump(by_alias=True)
        assert "chunkId" not in wire, f"chunkId leaked to wire: {wire}"
        assert "chunk_id" not in wire, f"chunk_id leaked to wire: {wire}"
        assert wire["source"] == "doc.pdf"
        # JSON roundtrip likewise excludes chunkId.
        as_json = json.loads(citation.model_dump_json(by_alias=True))
        assert "chunkId" not in as_json

    def test_kb_citation_invalid_dict_is_logged_and_skipped(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_tool_call("c1", "kb_search")
        # Missing required field "source" should be skipped without raising.
        builder.add_tool_result(
            "c1",
            "ok",
            kb_citations=[{"documentId": "d1", "knowledgeBaseId": "kb1"}],
        )
        resp = builder.finalize()
        # Invalid item is dropped; no top-level entry.
        assert resp.citations.kb_citations == []


# ---------------------------------------------------------------------------
# parsed_output extraction (§B8)
# ---------------------------------------------------------------------------


class TestParsedOutputExtraction:
    """``parsed_output`` populates when ``output_schema`` is provided."""

    def test_pure_json_output_parses(self) -> None:
        builder = ResponseBuilder(agent_id="echo", output_schema={"type": "object"})
        builder.add_token('{"a":1,"b":"hi"}')
        resp = builder.finalize()
        assert resp.parsed_output == {"a": 1, "b": "hi"}

    def test_fenced_json_block_parses(self) -> None:
        builder = ResponseBuilder(agent_id="echo", output_schema={"type": "object"})
        builder.add_token('```json\n{"x":2}\n```')
        resp = builder.finalize()
        assert resp.parsed_output == {"x": 2}

    def test_fenced_block_without_language_parses(self) -> None:
        builder = ResponseBuilder(agent_id="echo", output_schema={"type": "object"})
        builder.add_token('Here is the result:\n```\n{"y":3}\n```\n')
        resp = builder.finalize()
        assert resp.parsed_output == {"y": 3}

    def test_non_json_output_yields_none(self) -> None:
        builder = ResponseBuilder(agent_id="echo", output_schema={"type": "object"})
        builder.add_token("Sorry, I can't comply.")
        resp = builder.finalize()
        assert resp.parsed_output is None
        assert resp.output == "Sorry, I can't comply.", "Output text remains authoritative"

    def test_no_schema_means_no_parsed_output(self) -> None:
        builder = ResponseBuilder(agent_id="echo")  # output_schema=None
        builder.add_token('{"a":1}')
        resp = builder.finalize()
        assert resp.parsed_output is None, "Parsing only runs when schema is provided"

    def test_top_level_json_array_is_not_a_dict(self) -> None:
        """Per `_try_parse_json` contract only dicts are surfaced as parsed_output."""
        builder = ResponseBuilder(agent_id="echo", output_schema={"type": "array"})
        builder.add_token("[1,2,3]")
        resp = builder.finalize()
        assert resp.parsed_output is None, "Arrays don't fit dict[str, Any]"


class TestTryParseJsonHelper:
    """Sanity-check the private helper that powers parsed_output extraction."""

    def test_pure_json_object(self) -> None:
        assert _try_parse_json('{"a":1}') == {"a": 1}

    def test_whitespace_padded(self) -> None:
        assert _try_parse_json('  {"a":1}\n') == {"a": 1}

    def test_fenced_json(self) -> None:
        assert _try_parse_json('Prefix\n```json\n{"b":2}\n```\nSuffix') == {"b": 2}

    def test_invalid_returns_none(self) -> None:
        assert _try_parse_json("garbage") is None

    def test_empty_returns_none(self) -> None:
        assert _try_parse_json("") is None


# ---------------------------------------------------------------------------
# Option-B decision tree (plan §4 D2) — expanded coverage on ResponseBuilder
# ---------------------------------------------------------------------------


class TestOptionBDecisionTree:
    """Cover every row of the §4 D2 decision matrix end-to-end via ``finalize``."""

    @staticmethod
    def _invoice_schema() -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "customerId": {"type": "string"},
                "amount": {"type": "number"},
            },
            "required": ["customerId", "amount"],
        }

    def test_no_schema_no_expect_json_yields_none(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_token('{"customerId":"acme","amount":42.5}')
        resp = builder.finalize()
        assert resp.parsed_output is None
        assert resp.output == '{"customerId":"acme","amount":42.5}'

    def test_expect_json_only_parses_without_validation(self) -> None:
        builder = ResponseBuilder(agent_id="echo", expect_json=True)
        builder.add_token('{"anything": "goes"}')
        resp = builder.finalize()
        assert resp.parsed_output == {"anything": "goes"}

    def test_expect_json_with_prose_logs_warning(self, capsys: pytest.CaptureFixture[str]) -> None:
        builder = ResponseBuilder(agent_id="echo", expect_json=True)
        builder.add_token("Sorry, no JSON for you.")
        resp = builder.finalize()
        assert resp.parsed_output is None
        # Output text preserved on every code path.
        assert resp.output == "Sorry, no JSON for you."
        # The structured WARNING surfaces via structlog (stdout).
        captured = capsys.readouterr()
        assert "expect_json_but_not_parseable" in (captured.out + captured.err)

    def test_schema_match_populates_validated_dict(self) -> None:
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
        )
        builder.add_token('{"customerId":"acme-1","amount":42.5}')
        resp = builder.finalize()
        assert resp.parsed_output == {"customerId": "acme-1", "amount": 42.5}

    def test_schema_with_type_coercion_succeeds(self) -> None:
        """Pydantic v2 coerces a numeric string to ``float`` when the
        field is typed as ``number``."""
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
        )
        builder.add_token('{"customerId":"acme-1","amount":"42.5"}')
        resp = builder.finalize()
        assert resp.parsed_output == {"customerId": "acme-1", "amount": 42.5}

    def test_schema_mismatch_yields_none_with_warning(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        builder = ResponseBuilder(
            agent_id="echo",
            session_id="sess-1",
            output_schema=self._invoice_schema(),
        )
        # Missing required field "amount".
        builder.add_token('{"customerId": "acme-1"}')
        resp = builder.finalize()
        assert resp.parsed_output is None
        assert resp.output == '{"customerId": "acme-1"}', "Raw text preserved"
        captured = capsys.readouterr()
        assert "parsed_output_validation_failed" in (captured.out + captured.err)

    def test_schema_set_but_output_not_json_silent_none(self) -> None:
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
        )
        builder.add_token("Sorry, I cannot comply.")
        resp = builder.finalize()
        assert resp.parsed_output is None
        # No warning for "no JSON at all" when schema is set; that's
        # documented as silent per plan §4 D2.
        assert resp.output == "Sorry, I cannot comply."

    def test_schema_with_fenced_json_block_validates(self) -> None:
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
        )
        builder.add_token(
            'Here is the invoice:\n```json\n{"customerId":"acme-2","amount":99.99}\n```\n'
        )
        resp = builder.finalize()
        assert resp.parsed_output == {"customerId": "acme-2", "amount": 99.99}

    def test_malformed_schema_falls_back_to_raw_parsed(self) -> None:
        """When ``build_outcome_model`` returns ``None`` for a malformed
        schema, the response carries the raw parsed dict so callers
        with a relaxed schema still see something useful.

        We force the fallback by monkeypatching :func:`build_outcome_model`
        so we don't depend on pydantic's accident-of-rejection rules
        for any particular field name.
        """
        import agent_service_maf.framework.response_builder as rb_mod

        original = rb_mod.build_outcome_model
        try:
            rb_mod.build_outcome_model = lambda _schema: None  # type: ignore[assignment]
            builder = ResponseBuilder(
                agent_id="echo",
                output_schema={"type": "object", "properties": {}},
            )
            builder.add_token('{"customerId":"acme","amount":1.5}')
            resp = builder.finalize()
            assert resp.parsed_output == {"customerId": "acme", "amount": 1.5}, (
                "Legacy fallback must surface the raw parsed dict when "
                "build_outcome_model returns None"
            )
        finally:
            rb_mod.build_outcome_model = original

    def test_schema_wins_over_expect_json_when_both_set(self) -> None:
        """When both ``output_schema`` and ``expect_json`` are set, the
        schema path runs (validation > parse-only)."""
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
            expect_json=True,
        )
        # Missing required field — must fail validation, NOT silently
        # surface as a parsed dict.
        builder.add_token('{"customerId":"acme"}')
        resp = builder.finalize()
        assert resp.parsed_output is None

    def test_schema_wins_validation_succeeds(self) -> None:
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
            expect_json=True,
        )
        builder.add_token('{"customerId":"acme","amount":1.0}')
        resp = builder.finalize()
        assert resp.parsed_output == {"customerId": "acme", "amount": 1.0}

    def test_empty_output_with_schema_yields_none(self) -> None:
        builder = ResponseBuilder(
            agent_id="echo",
            output_schema=self._invoice_schema(),
        )
        resp = builder.finalize()
        assert resp.parsed_output is None


# ---------------------------------------------------------------------------
# Pre-built citations / performance / metadata
# ---------------------------------------------------------------------------


class TestPrebuiltCitations:
    """``set_citations`` lets adapters stamp a pre-built envelope."""

    def test_set_citations_wins_over_lazy_build(self) -> None:
        envelope = Citations(
            kb_citations=[
                KbCitation(source="hardcoded.pdf", knowledge_base_id="kb1"),
            ],
        )
        builder = ResponseBuilder(agent_id="echo")
        builder.set_citations(envelope)
        builder.add_tool_call("c1", "kb_search")
        builder.add_tool_result(
            "c1",
            "ok",
            kb_citations=[
                {
                    "source": "ignored.pdf",
                    "documentId": "d1",
                    "knowledgeBaseId": "kb-other",
                    "chunkId": "c",
                    "score": 0.9,
                }
            ],
        )
        resp = builder.finalize()
        # The pre-set envelope wins; the auto-aggregation is skipped.
        assert len(resp.citations.kb_citations) == 1
        assert resp.citations.kb_citations[0].source == "hardcoded.pdf"


class TestPerformanceBreakdown:
    """LLM / tool timings flow into Citations.performance when present."""

    def test_llm_timing_aggregates(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_token("hi")
        builder.add_llm_timing(100)
        builder.add_llm_timing(200)
        # Need a tool call to ensure citations envelope is built.
        builder.add_tool_call("c1", "kb_search")
        builder.add_tool_result("c1", "ok", duration_ms=50)
        resp = builder.finalize()
        perf = resp.citations.performance
        assert perf is not None
        assert perf.llm_duration_ms == 300, "LLM timings sum"
        assert perf.llm_call_count == 2, "LLM call count tracked"
        assert perf.tool_duration_ms == 50, "Tool duration tracked"
        assert perf.total_duration_ms >= 0
        assert perf.framework_overhead_ms >= 0

    def test_non_positive_llm_timing_ignored(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.add_llm_timing(0)
        builder.add_llm_timing(-5)
        builder.add_tool_call("c1", "kb_search")
        builder.add_tool_result("c1", "ok")
        resp = builder.finalize()
        perf = resp.citations.performance
        assert perf.llm_call_count == 0
        assert perf.llm_duration_ms == 0


class TestUsageAndMetadata:
    """``set_usage`` and ``merge_metadata`` flow through to the response."""

    def test_set_usage(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.set_usage({"promptTokens": 5, "completionTokens": 10, "totalTokens": 15})
        resp = builder.finalize()
        assert resp.usage == {"promptTokens": 5, "completionTokens": 10, "totalTokens": 15}

    def test_merge_metadata_accumulates(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.merge_metadata({"framework": "echo"})
        builder.merge_metadata({"request_id": "abc"})
        resp = builder.finalize()
        assert resp.metadata == {"framework": "echo", "request_id": "abc"}


class TestMemoryDegraded:
    """The memory_degraded flag round-trips through finalize."""

    def test_default_false(self) -> None:
        resp = ResponseBuilder(agent_id="echo").finalize()
        assert resp.memory_degraded is False

    def test_set_memory_degraded(self) -> None:
        builder = ResponseBuilder(agent_id="echo")
        builder.set_memory_degraded(True)
        resp = builder.finalize()
        assert resp.memory_degraded is True


class TestSessionAndTraceIds:
    """session_id and trace_id always echo on the response."""

    def test_session_id_propagates(self) -> None:
        resp = ResponseBuilder(agent_id="echo", session_id="sess-abc").finalize()
        assert resp.session_id == "sess-abc"

    def test_trace_id_propagates(self) -> None:
        resp = ResponseBuilder(agent_id="echo", trace_id="trace-1").finalize()
        assert resp.trace_id == "trace-1"
