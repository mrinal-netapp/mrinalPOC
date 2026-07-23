"""Unit tests for the §5.2 / §A1 ``CamelCaseModel`` wire convention.

The single configuration in ``core._base_model.CamelCaseModel`` flips
every inheriting model's wire form to camelCase while keeping Python
attribute names snake_case. These tests pin down the contract that
every other schema test in this file relies on.

Coverage:

- ``model_dump(by_alias=True)`` emits camelCase keys.
- Both camelCase and snake_case inputs validate (gradual consumer
  migration per §10.1).
- Nested ``CamelCaseModel`` fields nest correctly under their parent's
  camelCase key.
- Concrete wire-facing models inherit the convention:
  ``InvokeRequest`` / ``InvokeResponse`` / ``Citations`` / ``KbCitation``
  / ``AssistantMessageMetadata`` / ``ReadinessResponse`` /
  ``TaskStatusResponse``.
"""

from __future__ import annotations

from pydantic import Field

from agent_service_maf.core._base_model import CamelCaseModel
from agent_service_maf.core.interfaces import (
    AgentResponse,
    Citations,
    ContextUsed,
    KbCitation,
)
from agent_service_maf.interface_layer.models import (
    AssistantMessageMetadata,
    AsyncInvokeResponse,
    InvokeRequest,
    InvokeResponse,
    ReadinessResponse,
    SessionDetailResponse,
    SessionListResponse,
    TaskStatusResponse,
)

# ---------------------------------------------------------------------------
# Base CamelCaseModel contract
# ---------------------------------------------------------------------------


class _Sample(CamelCaseModel):
    session_id: str
    duration_ms: int = Field(default=0)
    memory_degraded: bool = False


class _Outer(CamelCaseModel):
    inner_obj: _Sample
    list_of_inners: list[_Sample] = []


class TestCamelCaseBase:
    def test_dump_by_alias_emits_camel_case(self) -> None:
        m = _Sample(session_id="abc", duration_ms=42, memory_degraded=True)
        dumped = m.model_dump(by_alias=True)
        assert dumped == {"sessionId": "abc", "durationMs": 42, "memoryDegraded": True}

    def test_dump_without_alias_emits_snake_case(self) -> None:
        m = _Sample(session_id="abc", duration_ms=42)
        dumped = m.model_dump(by_alias=False)
        assert "session_id" in dumped, "snake_case still available without alias"

    def test_validate_accepts_camel_case(self) -> None:
        m = _Sample.model_validate({"sessionId": "abc", "durationMs": 7})
        assert m.session_id == "abc"
        assert m.duration_ms == 7

    def test_validate_accepts_snake_case(self) -> None:
        m = _Sample.model_validate({"session_id": "abc", "duration_ms": 7})
        assert m.session_id == "abc"
        assert m.duration_ms == 7

    def test_validate_accepts_mixed(self) -> None:
        m = _Sample.model_validate({"sessionId": "abc", "duration_ms": 7, "memoryDegraded": True})
        assert m.session_id == "abc"
        assert m.duration_ms == 7
        assert m.memory_degraded is True

    def test_nested_inner_under_camel_parent_key(self) -> None:
        outer = _Outer(
            inner_obj=_Sample(session_id="s1"),
            list_of_inners=[_Sample(session_id="s2", duration_ms=10)],
        )
        dumped = outer.model_dump(by_alias=True)
        assert set(dumped.keys()) == {"innerObj", "listOfInners"}
        assert dumped["innerObj"] == {
            "sessionId": "s1",
            "durationMs": 0,
            "memoryDegraded": False,
        }
        assert dumped["listOfInners"][0]["sessionId"] == "s2"


# ---------------------------------------------------------------------------
# Concrete model inheritance
# ---------------------------------------------------------------------------


class TestInvokeResponseWire:
    def test_dump_by_alias_keys_are_camel(self) -> None:
        resp = InvokeResponse(
            agent_id="echo",
            output="hi",
            duration_ms=10,
            session_id="sess-1",
            trace_id="trace-1",
            memory_degraded=True,
        )
        dumped = resp.model_dump(by_alias=True)
        expected_keys = {
            "agentId",
            "output",
            "parsedOutput",
            "artifacts",
            "usage",
            "metadata",
            "citations",
            "durationMs",
            "memoryDegraded",
            "sessionId",
            "traceId",
        }
        assert expected_keys.issubset(dumped.keys()), (
            f"Missing wire keys: {expected_keys - dumped.keys()}"
        )

    def test_model_name_not_top_level(self) -> None:
        resp = InvokeResponse(agent_id="echo", output="hi")
        dumped = resp.model_dump(by_alias=True)
        assert "modelName" not in dumped, (
            "modelName must live under citations.respondingAgent.model only (§5.2.4 lock-in)"
        )

    def test_camelcase_input_accepted(self) -> None:
        resp = InvokeResponse.model_validate(
            {
                "agentId": "echo",
                "output": "hi",
                "sessionId": "sess-1",
                "durationMs": 42,
            }
        )
        assert resp.agent_id == "echo"
        assert resp.session_id == "sess-1"
        assert resp.duration_ms == 42


class TestInvokeRequestWire:
    def test_dump_by_alias_uses_camel(self) -> None:
        req = InvokeRequest(input="hi", session_id="sess-1")
        dumped = req.model_dump(by_alias=True)
        assert "sessionId" in dumped, "sessionId expected on wire"
        assert "configOverrides" in dumped, "configOverrides expected on wire"

    def test_legacy_modelid_not_a_field(self) -> None:
        """`modelId` (legacy top-level) is intentionally dropped per §5.1.2."""
        fields = InvokeRequest.model_fields
        assert "modelId" not in fields, "Legacy modelId must not be a field"
        assert "model_id" not in fields, "model_id (snake) must not be a field"

    def test_camel_input_accepted(self) -> None:
        req = InvokeRequest.model_validate({"input": "hi", "sessionId": "sess-2"})
        assert req.session_id == "sess-2"


class TestCitationsWire:
    def test_dump_uses_camel(self) -> None:
        envelope = Citations(
            context_used=ContextUsed(session_id="s1", history_messages_count=3),
            kb_citations=[
                KbCitation(source="d.pdf", knowledge_base_id="kb1", document_id="d1"),
            ],
        )
        dumped = envelope.model_dump(by_alias=True)
        assert "kbCitations" in dumped, "kb_citations -> kbCitations on the wire"
        assert "contextUsed" in dumped, "context_used -> contextUsed on the wire"
        ctx = dumped["contextUsed"]
        assert "sessionId" in ctx and "historyMessagesCount" in ctx

    def test_kb_citation_no_chunk_id_on_wire(self) -> None:
        citation = KbCitation(
            source="d.pdf",
            knowledge_base_id="kb1",
            document_id="d1",
            chunk_id="chunk-internal",
            score=0.8,
        )
        wire = citation.model_dump(by_alias=True)
        assert "chunkId" not in wire, "chunkId must never leak to the wire"


class TestAgentResponseInheritance:
    """Core AgentResponse also inherits the convention."""

    def test_dump_by_alias_camel(self) -> None:
        resp = AgentResponse(agent_id="echo", output="hi", session_id="s1")
        dumped = resp.model_dump(by_alias=True)
        assert "agentId" in dumped
        assert "sessionId" in dumped


class TestAssistantMessageMetadataWire:
    def test_dump_by_alias_camel(self) -> None:
        md = AssistantMessageMetadata(duration_ms=42, trace_id="t1", memory_degraded=True)
        dumped = md.model_dump(by_alias=True)
        assert "durationMs" in dumped
        assert "traceId" in dumped
        assert "memoryDegraded" in dumped


class TestReadinessResponseWire:
    def test_dump_by_alias_camel(self) -> None:
        r = ReadinessResponse(status="ready", uptime=5.5)
        dumped = r.model_dump(by_alias=True)
        assert dumped["status"] == "ready"
        # Single-word fields look identical between snake/camel; this test is
        # mostly a guard rail to ensure the model inherits from CamelCaseModel.
        assert "uptime" in dumped


class TestSessionResponseWire:
    def test_list_response_camel(self) -> None:
        m = SessionListResponse(scope="agent", project_id="p1", anchor="a1", user_id="u1")
        dumped = m.model_dump(by_alias=True)
        assert "projectId" in dumped
        assert "userId" in dumped
        assert "memoryDegraded" in dumped

    def test_detail_response_camel(self) -> None:
        m = SessionDetailResponse(
            scope="agent",
            project_id="p1",
            anchor="a1",
            user_id="u1",
            session_id="s1",
            created_at=1.0,
            last_accessed=2.0,
            token_count=3,
        )
        dumped = m.model_dump(by_alias=True)
        assert "sessionId" in dumped
        assert "createdAt" in dumped
        assert "lastAccessed" in dumped
        assert "tokenCount" in dumped


class TestTaskStatusResponseWire:
    def test_task_status_camel(self) -> None:
        from agent_service_maf.core.task_models import TaskStatus

        resp = TaskStatusResponse(
            task_id="t1",
            status=TaskStatus.RUNNING,
            project_id="p1",
            team_id="team1",
            agent_id="agent1",
            correlation_id="corr-1",
            created_at=1.0,
            updated_at=2.0,
            duration_ms=42,
            error_type="",
        )
        dumped = resp.model_dump(by_alias=True)
        assert "taskId" in dumped
        assert "projectId" in dumped
        assert "teamId" in dumped
        assert "agentId" in dumped
        assert "correlationId" in dumped
        assert "createdAt" in dumped
        assert "updatedAt" in dumped
        assert "durationMs" in dumped
        assert "errorType" in dumped


class TestAsyncInvokeResponseWire:
    def test_camel_dump(self) -> None:
        r = AsyncInvokeResponse(task_id="t1")
        dumped = r.model_dump(by_alias=True)
        assert "taskId" in dumped
        assert dumped["status"] == "running"
