"""A2A Task lifecycle manager.

Manages the state machine for A2A tasks:
  submitted → working → completed | failed | canceled

Maps internal AgentEvent streams to A2A TaskStatus updates.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import structlog

from agent_service_maf.core.exceptions import A2ATaskNotFoundError
from agent_service_maf.core.interfaces import AgentResponse, EventType
from agent_service_maf.core.service import AgentService
from agent_service_maf.interface_layer.protocols.a2a_models import (
    A2AArtifact,
    A2AMessage,
    Task,
    TaskCancelParams,
    TaskSendParams,
    TaskState,
    TaskStatus,
    TextPart,
)

logger = structlog.get_logger(__name__)


class A2ATaskManager:
    """Manages A2A task lifecycle and state transitions.

    Stores tasks in-memory (dict of task_id → Task).
    Delegates actual agent invocation to AgentService.
    """

    def __init__(self, agent_service: AgentService) -> None:
        self._service = agent_service
        self._tasks: dict[str, Task] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # tasks/send — synchronous task execution
    # ------------------------------------------------------------------

    async def send(self, params: TaskSendParams) -> Task:
        """Execute a task synchronously (tasks/send).

        Creates the task, invokes the agent, and returns the completed task.
        """
        task = await self._create_task(params)

        # Extract text input from message parts
        input_text = self._extract_text(params.message)

        try:
            # Transition to working
            await self._update_state(task.id, TaskState.WORKING)

            # Invoke agent
            response = await self._service.invoke(
                agent_id="default",
                input_text=input_text,
                session_id=params.sessionId,
                metadata={
                    "source": "a2a",
                    "task_id": task.id,
                    **params.metadata,
                },
            )

            # Build artifacts from response
            artifacts = self._response_to_artifacts(response)

            # Transition to completed
            await self._complete_task(task.id, response.output, artifacts)

        except asyncio.CancelledError:
            await self._update_state(task.id, TaskState.CANCELED)
        except Exception as e:
            logger.error("A2A task failed", task_id=task.id, error=str(e))
            await self._fail_task(task.id, str(e))

        return await self.get_task(task.id)

    # ------------------------------------------------------------------
    # tasks/sendSubscribe — streaming task execution
    # ------------------------------------------------------------------

    async def send_subscribe(self, params: TaskSendParams) -> AsyncIterator[Task]:
        """Execute a task with streaming updates (tasks/sendSubscribe).

        Yields Task snapshots as the agent produces events.
        """
        task = await self._create_task(params)
        input_text = self._extract_text(params.message)

        try:
            await self._update_state(task.id, TaskState.WORKING)
            yield await self.get_task(task.id)

            collected_output: list[str] = []
            artifacts: list[A2AArtifact] = []

            async for event in self._service.stream(
                agent_id="default",
                input_text=input_text,
                session_id=params.sessionId,
                metadata={
                    "source": "a2a",
                    "task_id": task.id,
                    **params.metadata,
                },
            ):
                # Check for cancellation
                cancel_event = self._cancel_events.get(task.id)
                if cancel_event and cancel_event.is_set():
                    await self._update_state(task.id, TaskState.CANCELED)
                    yield await self.get_task(task.id)
                    return

                # Map agent events to task updates
                if event.event_type == EventType.TOKEN:
                    collected_output.append(event.data)
                elif event.event_type == EventType.ARTIFACT:
                    artifacts.append(
                        A2AArtifact(
                            name=event.metadata.get("name"),
                            parts=[TextPart(text=event.data)],
                            index=len(artifacts),
                        )
                    )
                elif event.event_type == EventType.TOOL_CALL:
                    # Yield intermediate status with tool call info
                    async with self._lock:
                        t = self._tasks[task.id]
                        t.status = TaskStatus(
                            state=TaskState.WORKING,
                            message=A2AMessage(
                                role="agent",
                                parts=[TextPart(text=f"Calling tool: {event.data}")],
                            ),
                        )
                    yield await self.get_task(task.id)
                elif event.event_type == EventType.ERROR:
                    await self._fail_task(task.id, event.data)
                    yield await self.get_task(task.id)
                    return

            # Complete
            final_output = "".join(collected_output)
            await self._complete_task(task.id, final_output, artifacts)
            yield await self.get_task(task.id)

        except asyncio.CancelledError:
            await self._update_state(task.id, TaskState.CANCELED)
            yield await self.get_task(task.id)
        except Exception as e:
            logger.error("A2A streaming task failed", task_id=task.id, error=str(e))
            await self._fail_task(task.id, str(e))
            yield await self.get_task(task.id)

    # ------------------------------------------------------------------
    # tasks/get — retrieve task
    # ------------------------------------------------------------------

    async def get_task(self, task_id: str, history_length: int | None = None) -> Task:
        """Get a task by ID."""
        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise A2ATaskNotFoundError(f"Task '{task_id}' not found")

            # Optionally trim history
            if history_length is not None:
                task_copy = task.model_copy(deep=True)
                task_copy.history = task_copy.history[-history_length:]
                return task_copy

            return task.model_copy(deep=True)

    # ------------------------------------------------------------------
    # tasks/cancel — cancel a running task
    # ------------------------------------------------------------------

    async def cancel_task(self, params: TaskCancelParams) -> Task:
        """Request cancellation of a running task."""
        async with self._lock:
            task = self._tasks.get(params.id)
            if task is None:
                raise A2ATaskNotFoundError(f"Task '{params.id}' not found")

            if task.status.state not in (TaskState.SUBMITTED, TaskState.WORKING):
                # Task already in terminal state, just return it
                return task.model_copy(deep=True)

            # Signal cancellation
            cancel_event = self._cancel_events.get(params.id)
            if cancel_event:
                cancel_event.set()

            task.status = TaskStatus(state=TaskState.CANCELED)
            return task.model_copy(deep=True)

    # ------------------------------------------------------------------
    # Internal state management
    # ------------------------------------------------------------------

    async def _create_task(self, params: TaskSendParams) -> Task:
        """Create a new task in submitted state."""
        task = Task(
            id=params.id,
            sessionId=params.sessionId,
            status=TaskStatus(state=TaskState.SUBMITTED),
            history=[params.message],
            metadata=params.metadata,
        )

        async with self._lock:
            self._tasks[task.id] = task
            self._cancel_events[task.id] = asyncio.Event()

        logger.info("A2A task created", task_id=task.id)
        return task

    async def _update_state(self, task_id: str, state: TaskState) -> None:
        """Update task state."""
        async with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task.status = TaskStatus(state=state)

    async def _complete_task(
        self,
        task_id: str,
        output: str,
        artifacts: list[A2AArtifact] | None = None,
    ) -> None:
        """Mark task as completed with output."""
        async with self._lock:
            task = self._tasks.get(task_id)
            if task:
                agent_message = A2AMessage(
                    role="agent",
                    parts=[TextPart(text=output)],
                )
                task.status = TaskStatus(
                    state=TaskState.COMPLETED,
                    message=agent_message,
                )
                task.history.append(agent_message)
                if artifacts:
                    task.artifacts = artifacts

    async def _fail_task(self, task_id: str, error_message: str) -> None:
        """Mark task as failed."""
        async with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task.status = TaskStatus(
                    state=TaskState.FAILED,
                    message=A2AMessage(
                        role="agent",
                        parts=[TextPart(text=f"Error: {error_message}")],
                    ),
                )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_text(message: A2AMessage) -> str:
        """Extract text content from an A2A message's parts."""
        texts: list[str] = []
        for part in message.parts:
            if isinstance(part, TextPart):
                texts.append(part.text)
        return "\n".join(texts) if texts else ""

    @staticmethod
    def _response_to_artifacts(response: AgentResponse) -> list[A2AArtifact]:
        """Convert AgentResponse artifacts to A2A artifacts."""
        a2a_artifacts: list[A2AArtifact] = []
        for i, artifact in enumerate(response.artifacts):
            content = artifact.get("content", str(artifact))
            a2a_artifacts.append(
                A2AArtifact(
                    name=artifact.get("name"),
                    description=artifact.get("description"),
                    parts=[TextPart(text=str(content))],
                    index=i,
                )
            )
        return a2a_artifacts
