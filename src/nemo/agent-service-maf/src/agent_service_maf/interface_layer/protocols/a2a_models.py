"""Google Agent-to-Agent (A2A) protocol models.

Implements the data models from the Google A2A specification:
https://google.github.io/A2A/

Key concepts:
- Agent Card: Published at /.well-known/agent.json, describes capabilities
- Task: Unit of work with a lifecycle (submitted → working → completed/failed)
- Message: Communication unit containing Parts (text, file, data)
- Artifact: Output produced by the agent during task execution
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field

# ------------------------------------------------------------------
# Agent Card (published at /.well-known/agent.json)
# ------------------------------------------------------------------


class A2AAgentSkill(BaseModel):
    """A skill/capability that the agent offers."""

    id: str
    name: str
    description: str
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list, description="Example prompts")


class A2AAgentCapabilities(BaseModel):
    """What the agent supports."""

    streaming: bool = True
    pushNotifications: bool = False
    stateTransitionHistory: bool = False


class A2AAgentAuthentication(BaseModel):
    """Authentication configuration for the agent."""

    schemes: list[str] = Field(default_factory=lambda: ["none"])
    credentials: str | None = None


class A2AAgentCard(BaseModel):
    """Agent Card — the public identity of this agent service.

    Published at /.well-known/agent.json per the A2A spec.
    """

    name: str
    description: str
    url: str
    version: str = "0.1.0"
    documentationUrl: str | None = None
    capabilities: A2AAgentCapabilities = Field(default_factory=A2AAgentCapabilities)
    authentication: A2AAgentAuthentication = Field(default_factory=A2AAgentAuthentication)
    defaultInputModes: list[str] = Field(default_factory=lambda: ["text"])
    defaultOutputModes: list[str] = Field(default_factory=lambda: ["text"])
    skills: list[A2AAgentSkill] = Field(default_factory=list)


# ------------------------------------------------------------------
# Message Parts
# ------------------------------------------------------------------


class TextPart(BaseModel):
    """A text content part."""

    type: Literal["text"] = "text"
    text: str


class FilePart(BaseModel):
    """A file content part."""

    type: Literal["file"] = "file"
    file: dict[str, Any] = Field(
        ..., description="File data: {name, mimeType, bytes (base64) or uri}"
    )


class DataPart(BaseModel):
    """A structured data content part."""

    type: Literal["data"] = "data"
    data: dict[str, Any]


# Union type for message parts
Part = TextPart | FilePart | DataPart


# ------------------------------------------------------------------
# Message
# ------------------------------------------------------------------


class A2AMessage(BaseModel):
    """A message in the A2A protocol — contains one or more Parts."""

    role: str = Field(..., description="'user' or 'agent'")
    parts: list[Part]
    metadata: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------------
# Artifact
# ------------------------------------------------------------------


class A2AArtifact(BaseModel):
    """An output artifact produced during task execution."""

    name: str | None = None
    description: str | None = None
    parts: list[Part]
    index: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------------
# Task Lifecycle
# ------------------------------------------------------------------


class TaskState(str, Enum):
    """Task lifecycle states per A2A spec."""

    SUBMITTED = "submitted"
    WORKING = "working"
    INPUT_REQUIRED = "input-required"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"


class TaskStatus(BaseModel):
    """Current status of a task."""

    state: TaskState
    message: A2AMessage | None = None
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class Task(BaseModel):
    """An A2A Task — the core unit of work."""

    id: str
    sessionId: str | None = None
    status: TaskStatus
    artifacts: list[A2AArtifact] = Field(default_factory=list)
    history: list[A2AMessage] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


# ------------------------------------------------------------------
# JSON-RPC 2.0 Wrappers
# ------------------------------------------------------------------


class JSONRPCRequest(BaseModel):
    """JSON-RPC 2.0 request."""

    jsonrpc: str = "2.0"
    id: str | int
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class JSONRPCResponse(BaseModel):
    """JSON-RPC 2.0 response."""

    jsonrpc: str = "2.0"
    id: str | int
    result: Any | None = None
    error: JSONRPCError | None = None


class JSONRPCError(BaseModel):
    """JSON-RPC 2.0 error."""

    code: int
    message: str
    data: Any | None = None


# Standard JSON-RPC error codes
JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
JSONRPC_INTERNAL_ERROR = -32603

# A2A-specific error codes
A2A_TASK_NOT_FOUND = -32001
A2A_TASK_NOT_CANCELABLE = -32002
A2A_PUSH_NOT_SUPPORTED = -32003
A2A_UNSUPPORTED_OPERATION = -32004


# ------------------------------------------------------------------
# A2A Method Parameters
# ------------------------------------------------------------------


class TaskSendParams(BaseModel):
    """Parameters for tasks/send and tasks/sendSubscribe."""

    id: str = Field(..., description="Task ID (client-generated)")
    sessionId: str | None = None
    message: A2AMessage
    acceptedOutputModes: list[str] = Field(default_factory=lambda: ["text"])
    metadata: dict[str, Any] = Field(default_factory=dict)


class TaskQueryParams(BaseModel):
    """Parameters for tasks/get."""

    id: str
    historyLength: int | None = None


class TaskCancelParams(BaseModel):
    """Parameters for tasks/cancel."""

    id: str
