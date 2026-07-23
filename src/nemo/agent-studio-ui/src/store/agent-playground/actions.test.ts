import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AppDispatch, RootState } from "@/store/store.types";
import { streamAgentInvoke } from "@/routes/pages/agents/api/agent-stream.service";
import {
  buildAgentStreamUrl,
  buildAgentTeamStreamUrl,
} from "@/routes/pages/agents/api/agents-api.paths";
import { isTeamAgentId } from "@/routes/pages/agents/utils/agents-api-mapper";
import { agentsRuntimeApi } from "@/routes/pages/agents/api/agents-runtime-api.slice";
import type { AgentInvokeResponse } from "@/routes/pages/agents/api/agents.types";

import { AGENT_PLAYGROUND_SLICE_NAME, initialAgentPlaygroundState } from "./model";
import { agentPlaygroundReducer } from "./reducer";
import { cancelAgentStream, sendAgentMessage } from "./actions";

vi.mock("@/routes/pages/agents/api/agent-stream.service", () => ({
  streamAgentInvoke: vi.fn(),
}));

vi.mock("@/routes/pages/agents/api/agents-api.paths", () => ({
  buildAgentStreamUrl: vi.fn((id: string) => `/single/${id}`),
  buildAgentTeamStreamUrl: vi.fn((id: string) => `/team/${id}`),
}));

vi.mock("@/routes/pages/agents/utils/agents-api-mapper", () => ({
  isTeamAgentId: vi.fn((id: string) => id.startsWith("agr-")),
}));

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

vi.mock("@/routes/pages/agents/api/agents-runtime-api.slice", () => ({
  agentsRuntimeApi: {
    endpoints: { invokeAgent: { initiate: vi.fn() } },
  },
  invalidateAgentSessionsCache: vi.fn(),
}));

type InvokeInitiate = typeof agentsRuntimeApi.endpoints.invokeAgent.initiate;

// The mocked `initiate` must return a thunk that yields `{ unwrap }`, mirroring
// RTK Query, so the thunk-capable harness dispatch can resolve the fallback.
function mockRestInvokeResolves(response: AgentInvokeResponse): void {
  vi.mocked(agentsRuntimeApi.endpoints.invokeAgent.initiate).mockReturnValue(
    (() => ({ unwrap: () => Promise.resolve(response) })) as unknown as ReturnType<InvokeInitiate>,
  );
}

function mockRestInvokeRejects(): void {
  vi.mocked(agentsRuntimeApi.endpoints.invokeAgent.initiate).mockReturnValue(
    (() => ({
      unwrap: () => Promise.reject(new Error("rest invoke failed")),
    })) as unknown as ReturnType<InvokeInitiate>,
  );
}

async function* throwingStream(): AsyncGenerator<unknown> {
  await Promise.reject(new Error("network down"));
  yield undefined;
}

async function* fromEvents(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event;
  }
}

function mockStream(events: unknown[]): void {
  vi.mocked(streamAgentInvoke).mockImplementation(
    () => fromEvents(events) as ReturnType<typeof streamAgentInvoke>,
  );
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Minimal store harness: dispatched plain actions are reduced into local state
// so the thunk's `getState` reflects updates (needed for the in-flight guard
// and session-id threading).
function makeHarness(projectId = "proj-1") {
  let state = initialAgentPlaygroundState;
  const getState = (() => ({
    [AGENT_PLAYGROUND_SLICE_NAME]: state,
    projectContext: { activeProject: { id: projectId, name: "", role: "admin" as const } },
  })) as () => RootState;
  const dispatch = ((action: unknown) => {
    // Thunks (e.g. the RTK Query `invokeAgent.initiate` used by the REST
    // fallback) are functions — run them so `.unwrap()` resolves.
    if (typeof action === "function") {
      return (action as (d: AppDispatch, g: () => RootState) => unknown)(dispatch, getState);
    }
    state = agentPlaygroundReducer(state, action as Parameters<typeof agentPlaygroundReducer>[1]);
    return action;
  }) as unknown as AppDispatch;
  return { getState, dispatch, current: () => state };
}

const DONE_EVENT = {
  type: "done",
  data: {
    sessionId: "sess-1",
    traceId: "trace-1",
    latencyMs: 123,
    modelName: "gpt-test",
    usage: { promptTokens: 10, completionTokens: 5 },
    citations: [{ source: "doc-1" }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the REST fallback fails, so unconfigured failure paths still show
  // the "Failed to get a response" message. Tests opt into success explicitly.
  mockRestInvokeRejects();
});

describe("sendAgentMessage thunk", () => {
  it("[tag:agent-playground-store] is a no-op when the agent id is null", async () => {
    const { dispatch, getState, current } = makeHarness();

    sendAgentMessage(null, "Hello")(dispatch, getState);
    await flush();

    expect(streamAgentInvoke).not.toHaveBeenCalled();
    expect(current().messages).toEqual([]);
    expect(current().isStreaming).toBe(false);
  });

  it("[tag:agent-playground-store] streams assistant text, tool steps, and run metrics on a full run", async () => {
    mockStream([
      { type: "message", data: "Hello" },
      { type: "message", data: " world" },
      { type: "tool_call_start", data: { toolCallId: "tc-1", toolName: "search", args: { q: "x" } } },
      { type: "tool_call_result", data: { toolCallId: "tc-1", result: "ok" } },
      DONE_EVENT,
    ]);

    const { dispatch, getState, current } = makeHarness();
    sendAgentMessage("ag-1", "Hi", { modelId: "gpt-test" })(dispatch, getState);
    await flush();

    expect(streamAgentInvoke).toHaveBeenCalledTimes(1);
    expect(buildAgentStreamUrl).toHaveBeenCalledWith("ag-1", "proj-1", { staging: "playground" });

    const state = current();
    expect(state.isStreaming).toBe(false);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "user", content: "Hi" });
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "Hello world",
      isStreaming: false,
      latencyMs: 123,
      modelName: "gpt-test",
    });
    expect(state.messages[1].usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    expect(state.liveExecutionSteps).toHaveLength(1);
    expect(state.liveExecutionSteps[0]).toMatchObject({ toolCallId: "tc-1", status: "completed", result: "ok" });

    expect(state.sessionId).toBe("sess-1");
    expect(state.lastRunMetrics).toMatchObject({ sessionId: "sess-1", traceId: "trace-1", latencyMs: 123 });
    expect(state.lastRunMetrics?.usage?.totalTokens).toBe(15);
  });

  it("[tag:agent-playground-store] routes team agent ids to the team stream endpoint", async () => {
    mockStream([DONE_EVENT]);
    const { dispatch, getState } = makeHarness();

    sendAgentMessage("agr-1", "Hi")(dispatch, getState);
    await flush();

    expect(isTeamAgentId).toHaveBeenCalledWith("agr-1");
    expect(buildAgentTeamStreamUrl).toHaveBeenCalledWith("agr-1", "proj-1", { staging: "playground" });
    expect(buildAgentStreamUrl).not.toHaveBeenCalled();
  });

  it("[tag:agent-playground-store] threads the session id from a completed run into the next request", async () => {
    mockStream([DONE_EVENT]);
    const { dispatch, getState } = makeHarness();

    sendAgentMessage("ag-1", "first")(dispatch, getState);
    await flush();

    mockStream([{ type: "done", data: { sessionId: "sess-2" } }]);
    sendAgentMessage("ag-1", "second")(dispatch, getState);
    await flush();

    const lastCallRequest = vi.mocked(streamAgentInvoke).mock.calls[1][1];
    expect(lastCallRequest.sessionId).toBe("sess-1");
  });

  it("[tag:agent-playground-store] ignores a second send while a stream is in flight", async () => {
    vi.mocked(streamAgentInvoke).mockImplementation(() => {
      async function* hang(): AsyncGenerator<unknown> {
        yield { type: "message", data: "partial" };
        await new Promise<void>(() => {});
      }
      return hang() as ReturnType<typeof streamAgentInvoke>;
    });

    const { dispatch, getState, current } = makeHarness();
    sendAgentMessage("ag-1", "first")(dispatch, getState);
    await flush();
    expect(current().isStreaming).toBe(true);

    sendAgentMessage("ag-1", "second")(dispatch, getState);

    expect(streamAgentInvoke).toHaveBeenCalledTimes(1);
  });

  it("[tag:agent-playground-store] surfaces a server `error` event on the assistant message", async () => {
    mockStream([{ type: "error", data: "boom" }]);
    const { dispatch, getState, current } = makeHarness();

    sendAgentMessage("ag-1", "Hi")(dispatch, getState);
    await flush();

    expect(current().messages[1]).toMatchObject({ role: "assistant", content: "Error: boom", isStreaming: false });
    expect(current().isStreaming).toBe(false);
  });

  it("[tag:agent-playground-store] shows a fallback message when the stream throws and the REST fallback also fails", async () => {
    vi.mocked(streamAgentInvoke).mockImplementation(
      () => throwingStream() as ReturnType<typeof streamAgentInvoke>,
    );
    mockRestInvokeRejects();

    const { dispatch, getState, current } = makeHarness();
    sendAgentMessage("ag-1", "Hi")(dispatch, getState);
    await flush();
    await flush();

    expect(current().messages[1]).toMatchObject({
      role: "assistant",
      content: "Failed to get a response: network down",
      isStreaming: false,
    });
    expect(current().isStreaming).toBe(false);
  });

  it("[tag:agent-playground-store] falls back to the REST invoke endpoint when the stream throws", async () => {
    vi.mocked(streamAgentInvoke).mockImplementation(
      () => throwingStream() as ReturnType<typeof streamAgentInvoke>,
    );
    mockRestInvokeResolves({
      response: "REST answer",
      sessionId: "sess-rest",
      latencyMs: 50,
      modelName: "gpt-test",
      usage: { promptTokens: 3, completionTokens: 2 },
    });

    const { dispatch, getState, current } = makeHarness();
    sendAgentMessage("ag-1", "Hi")(dispatch, getState);
    await flush();
    await flush();

    expect(agentsRuntimeApi.endpoints.invokeAgent.initiate).toHaveBeenCalledWith({
      agentId: "ag-1",
      body: { input: "Hi", sessionId: null },
      queryParams: { staging: "playground" },
    });

    const state = current();
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: "REST answer",
      isStreaming: false,
      modelName: "gpt-test",
    });
    expect(state.messages[1].usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(state.sessionId).toBe("sess-rest");
    expect(state.isStreaming).toBe(false);
  });

  it("[tag:agent-playground-store] does not attempt a REST fallback for team agents", async () => {
    vi.mocked(streamAgentInvoke).mockImplementation(
      () => throwingStream() as ReturnType<typeof streamAgentInvoke>,
    );

    const { dispatch, getState, current } = makeHarness();
    sendAgentMessage("agr-1", "Hi")(dispatch, getState);
    await flush();
    await flush();

    expect(agentsRuntimeApi.endpoints.invokeAgent.initiate).not.toHaveBeenCalled();
    expect(current().messages[1]).toMatchObject({
      content: "Failed to get a response: network down",
      isStreaming: false,
    });
  });

  it("[tag:agent-playground-store] does not thread a session id for single-turn agents", async () => {
    mockStream([DONE_EVENT]);
    const { dispatch, getState } = makeHarness();

    sendAgentMessage("ag-1", "first", { interactionMode: "single-turn" })(dispatch, getState);
    await flush();

    mockStream([{ type: "done", data: { sessionId: "sess-2" } }]);
    sendAgentMessage("ag-1", "second", { interactionMode: "single-turn" })(dispatch, getState);
    await flush();

    const secondRequest = vi.mocked(streamAgentInvoke).mock.calls[1][1];
    expect(secondRequest.sessionId).toBeUndefined();
  });

  it("[tag:agent-playground-store] threads the session id for multi-turn agents", async () => {
    mockStream([DONE_EVENT]);
    const { dispatch, getState } = makeHarness();

    sendAgentMessage("ag-1", "first", { interactionMode: "multi-turn" })(dispatch, getState);
    await flush();

    mockStream([{ type: "done", data: { sessionId: "sess-2" } }]);
    sendAgentMessage("ag-1", "second", { interactionMode: "multi-turn" })(dispatch, getState);
    await flush();

    const secondRequest = vi.mocked(streamAgentInvoke).mock.calls[1][1];
    expect(secondRequest.sessionId).toBe("sess-1");
  });
});

describe("cancelAgentStream thunk", () => {
  it("[tag:agent-playground-store] aborts the in-flight stream and clears the streaming flag", async () => {
    vi.mocked(streamAgentInvoke).mockImplementation(() => {
      async function* hang(): AsyncGenerator<unknown> {
        yield { type: "message", data: "partial" };
        await new Promise<void>(() => {});
      }
      return hang() as ReturnType<typeof streamAgentInvoke>;
    });

    const { dispatch, getState, current } = makeHarness();
    sendAgentMessage("ag-1", "Hi")(dispatch, getState);
    await flush();
    expect(current().isStreaming).toBe(true);

    cancelAgentStream()(dispatch);
    expect(current().isStreaming).toBe(false);
    expect(streamAgentInvoke).toHaveBeenCalledTimes(1);
  });

  it("[tag:agent-playground-store] is safe to call when nothing is streaming", () => {
    const { dispatch, current } = makeHarness();
    expect(() => cancelAgentStream()(dispatch)).not.toThrow();
    expect(current().isStreaming).toBe(false);
  });
});
