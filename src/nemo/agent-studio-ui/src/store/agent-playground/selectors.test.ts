import { describe, expect, it } from "vitest";

import type { RootState } from "@/store/store.types";

import { initialAgentPlaygroundState, type AgentPlaygroundState } from "./model";
import {
  selectIsStreaming,
  selectLastRunMetrics,
  selectLiveExecutionSteps,
  selectPlaygroundMessages,
  selectPlaygroundSessionId,
} from "./selectors";

function rootWith(agentPlayground: AgentPlaygroundState): RootState {
  return { agentPlayground } as unknown as RootState;
}

describe("agent-playground selectors", () => {
  it("[tag:agent-playground-store] selectPlaygroundMessages reads the transcript", () => {
    const state = rootWith({
      ...initialAgentPlaygroundState,
      messages: [{ id: "m1", role: "user", content: "Hi" }],
    });
    expect(selectPlaygroundMessages(state)).toEqual([{ id: "m1", role: "user", content: "Hi" }]);
  });

  it("[tag:agent-playground-store] selectLiveExecutionSteps reads the timeline", () => {
    const state = rootWith({
      ...initialAgentPlaygroundState,
      liveExecutionSteps: [{ toolCallId: "tc-1", toolName: "search", status: "running" }],
    });
    expect(selectLiveExecutionSteps(state)).toHaveLength(1);
  });

  it("[tag:agent-playground-store] selectLastRunMetrics reads the metrics", () => {
    const state = rootWith({
      ...initialAgentPlaygroundState,
      lastRunMetrics: { sessionId: "sess-1", latencyMs: 9 },
    });
    expect(selectLastRunMetrics(state)).toMatchObject({ sessionId: "sess-1", latencyMs: 9 });
  });

  it("[tag:agent-playground-store] selectIsStreaming reads the streaming flag", () => {
    expect(selectIsStreaming(rootWith({ ...initialAgentPlaygroundState, isStreaming: true }))).toBe(true);
  });

  it("[tag:agent-playground-store] selectPlaygroundSessionId reads the session id", () => {
    expect(
      selectPlaygroundSessionId(rootWith({ ...initialAgentPlaygroundState, sessionId: "sess-9" })),
    ).toBe("sess-9");
  });
});
