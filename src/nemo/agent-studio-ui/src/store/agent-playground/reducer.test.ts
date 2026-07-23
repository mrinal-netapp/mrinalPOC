import { describe, expect, it, vi } from "vitest";

import type { AgentStreamDonePayload } from "@/routes/pages/agents/api/agents.types";
import type { PlaygroundExecutionStep } from "@/routes/pages/agents/playground/agent-playground.types";

import { initialAgentPlaygroundState } from "./model";
import {
  agentPlaygroundReducer,
  agentTurnCompleted,
  agentTurnStarted,
  assistantTextAppended,
  playgroundReset,
  runCompleted,
  streamEnded,
  streamErrored,
  streamFailed,
  streamStarted,
  toolCallResulted,
  toolCallStarted,
} from "./reducer";

// Keep the execution-step shape observable so `liveExecutionSteps` transitions
// can be asserted without coupling to the real builder's internals.
vi.mock("@/routes/pages/agents/playground/agent-playground-execution.utils", () => ({
  buildExecutionStepFromToolCall: (
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: unknown,
    status: string,
    elapsedMs?: number,
    errorMessage?: string,
  ) => ({ toolCallId, toolName, args, result, status, elapsedMs, errorMessage }),
  buildExecutionStepsFromAgentTrace: (
    agentTrace?: Array<{ toolExecutions?: Array<Record<string, unknown>> }> | null,
  ) =>
    (agentTrace ?? []).flatMap((step, stepIndex) =>
      (step.toolExecutions ?? []).map((te, execIndex) => ({
        toolCallId:
          (te.toolCallId as string) ?? `${te.toolName as string}-${stepIndex}-${execIndex}`,
        toolName: te.toolName,
        args: te.arguments,
        result: te.resultSummary,
        status: te.error ? "failed" : "completed",
        elapsedMs: te.durationMs,
      })),
    ),
}));

const ASSISTANT_ID = "assistant-1";
const USER_ID = "user-1";

function startedState() {
  return agentPlaygroundReducer(
    undefined,
    streamStarted({ userMessageId: USER_ID, assistantMessageId: ASSISTANT_ID, text: "Hi" }),
  );
}

const RUNNING_STEP: PlaygroundExecutionStep = {
  toolCallId: "tc-1",
  toolName: "search",
  args: { q: "x" },
  status: "running",
};

describe("agent-playground reducer", () => {
  it("[tag:agent-playground-store] returns the initial state", () => {
    expect(agentPlaygroundReducer(undefined, { type: "@@INIT" })).toEqual(
      initialAgentPlaygroundState,
    );
  });

  it("[tag:agent-playground-store] streamStarted seeds user + assistant messages and flips isStreaming", () => {
    const state = startedState();
    expect(state.isStreaming).toBe(true);
    expect(state.messages).toEqual([
      { id: USER_ID, role: "user", content: "Hi" },
      { id: ASSISTANT_ID, role: "assistant", content: "", isStreaming: true },
    ]);
    expect(state.liveExecutionSteps).toEqual([]);
  });

  it("[tag:agent-playground-store] streamStarted clears a previous run's execution steps", () => {
    let state = startedState();
    state = agentPlaygroundReducer(state, toolCallStarted(RUNNING_STEP));
    expect(state.liveExecutionSteps).toHaveLength(1);

    state = agentPlaygroundReducer(
      state,
      streamStarted({ userMessageId: "u2", assistantMessageId: "a2", text: "again" }),
    );
    expect(state.liveExecutionSteps).toEqual([]);
  });

  it("[tag:agent-playground-store] assistantTextAppended accumulates streamed chunks", () => {
    let state = startedState();
    state = agentPlaygroundReducer(state, assistantTextAppended({ assistantMessageId: ASSISTANT_ID, text: "Hello" }));
    state = agentPlaygroundReducer(state, assistantTextAppended({ assistantMessageId: ASSISTANT_ID, text: " world" }));
    expect(state.messages[1].content).toBe("Hello world");
  });

  it("[tag:agent-playground-store] assistantTextAppended ignores an unknown message id", () => {
    const state = agentPlaygroundReducer(
      startedState(),
      assistantTextAppended({ assistantMessageId: "missing", text: "x" }),
    );
    expect(state.messages[1].content).toBe("");
  });

  it("[tag:agent-playground-store] toolCallStarted appends a running step", () => {
    const state = agentPlaygroundReducer(startedState(), toolCallStarted(RUNNING_STEP));
    expect(state.liveExecutionSteps).toEqual([RUNNING_STEP]);
  });

  it("[tag:agent-playground-store] toolCallResulted replaces the matching step as completed", () => {
    let state = agentPlaygroundReducer(startedState(), toolCallStarted(RUNNING_STEP));
    state = agentPlaygroundReducer(state, toolCallResulted({ toolCallId: "tc-1", result: "ok", elapsedMs: 42 }));
    expect(state.liveExecutionSteps).toEqual([
      { toolCallId: "tc-1", toolName: "search", args: { q: "x" }, result: "ok", status: "completed", elapsedMs: 42 },
    ]);
  });

  it("[tag:agent-playground-store] toolCallResulted leaves non-matching steps untouched", () => {
    let state = agentPlaygroundReducer(startedState(), toolCallStarted(RUNNING_STEP));
    state = agentPlaygroundReducer(state, toolCallResulted({ toolCallId: "other", result: "ok" }));
    expect(state.liveExecutionSteps).toEqual([RUNNING_STEP]);
  });

  it("[tag:agent-playground-store] runCompleted records metrics, session id, and finalises the message", () => {
    const done: AgentStreamDonePayload = {
      sessionId: "sess-1",
      traceId: "trace-1",
      latencyMs: 123,
      modelName: "gpt-test",
      usage: { promptTokens: 10, completionTokens: 5 },
      citations: [{ source: "doc-1" }],
    };
    const state = agentPlaygroundReducer(startedState(), runCompleted({ assistantMessageId: ASSISTANT_ID, done }));

    expect(state.sessionId).toBe("sess-1");
    expect(state.lastRunMetrics).toMatchObject({
      sessionId: "sess-1",
      traceId: "trace-1",
      latencyMs: 123,
      modelName: "gpt-test",
    });
    expect(state.lastRunMetrics?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(state.messages[1]).toMatchObject({
      isStreaming: false,
      latencyMs: 123,
      modelName: "gpt-test",
    });
    expect(state.messages[1].usage?.totalTokens).toBe(15);
  });

  it("[tag:agent-playground-store] runCompleted handles a done event with no usage/model/citations", () => {
    const done: AgentStreamDonePayload = { sessionId: "s2", traceId: "t2", latencyMs: 5 };
    const state = agentPlaygroundReducer(startedState(), runCompleted({ assistantMessageId: ASSISTANT_ID, done }));

    expect(state.lastRunMetrics).toMatchObject({ sessionId: "s2", latencyMs: 5 });
    expect(state.lastRunMetrics?.usage).toBeUndefined();
    expect(state.messages[1].usage).toBeUndefined();
    expect(state.messages[1].modelName).toBeUndefined();
  });

  it("[tag:agent-playground-store] streamErrored surfaces the server message on the assistant message", () => {
    const state = agentPlaygroundReducer(startedState(), streamErrored({ assistantMessageId: ASSISTANT_ID, message: "boom" }));
    expect(state.messages[1]).toMatchObject({ content: "Error: boom", isStreaming: false });
  });

  it("[tag:agent-playground-store] streamFailed sets the generic fallback copy", () => {
    const state = agentPlaygroundReducer(startedState(), streamFailed({ assistantMessageId: ASSISTANT_ID }));
    expect(state.messages[1]).toMatchObject({
      content: "Failed to get a response. Please try again.",
      isStreaming: false,
    });
  });

  it("[tag:agent-playground-store] streamEnded clears the streaming flag", () => {
    const state = agentPlaygroundReducer(startedState(), streamEnded());
    expect(state.isStreaming).toBe(false);
  });

  it("[tag:agent-playground-store] playgroundReset restores the initial state", () => {
    const state = agentPlaygroundReducer(startedState(), playgroundReset());
    expect(state).toEqual(initialAgentPlaygroundState);
  });

  it("[tag:agent-playground-store] agentTurnStarted/Completed tracks per-agent activity", () => {
    let state = agentPlaygroundReducer(
      startedState(),
      agentTurnStarted({ agentName: "researcher", startedAt: "2026-01-01T00:00:00Z" }),
    );
    expect(state.liveAgentActivity).toEqual([
      { agentName: "researcher", status: "running", startedAt: "2026-01-01T00:00:00Z" },
    ]);

    // duplicate started for a still-running agent is ignored
    state = agentPlaygroundReducer(state, agentTurnStarted({ agentName: "researcher" }));
    expect(state.liveAgentActivity).toHaveLength(1);

    state = agentPlaygroundReducer(
      state,
      agentTurnCompleted({ agentName: "researcher", durationMs: 812 }),
    );
    expect(state.liveAgentActivity[0]).toMatchObject({
      agentName: "researcher",
      status: "completed",
      durationMs: 812,
    });

    // a second agent's turn appends a new running entry
    state = agentPlaygroundReducer(state, agentTurnStarted({ agentName: "writer" }));
    expect(state.liveAgentActivity.map((a) => `${a.agentName}:${a.status}`)).toEqual([
      "researcher:completed",
      "writer:running",
    ]);
  });

  it("[tag:agent-playground-store] streamStarted clears prior agent activity", () => {
    const withActivity = agentPlaygroundReducer(
      startedState(),
      agentTurnStarted({ agentName: "researcher" }),
    );
    const restarted = agentPlaygroundReducer(
      withActivity,
      streamStarted({ userMessageId: "u2", assistantMessageId: "a2", text: "again" }),
    );
    expect(restarted.liveAgentActivity).toEqual([]);
  });
});
