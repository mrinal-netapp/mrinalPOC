import { createSelector } from "@reduxjs/toolkit";

import type { RootState } from "@/store/store.types";
import type {
  PlaygroundAgentActivity,
  PlaygroundChatMessage,
  PlaygroundExecutionStep,
  PlaygroundRunMetrics,
} from "@/routes/pages/agents/playground/agent-playground.types";

import { AGENT_PLAYGROUND_SLICE_NAME, type AgentPlaygroundState } from "./model";

const selectAgentPlaygroundSlice = (state: RootState): AgentPlaygroundState =>
  state[AGENT_PLAYGROUND_SLICE_NAME];

export const selectPlaygroundMessages = createSelector(
  selectAgentPlaygroundSlice,
  (slice): PlaygroundChatMessage[] => slice.messages,
);

export const selectLiveExecutionSteps = createSelector(
  selectAgentPlaygroundSlice,
  (slice): PlaygroundExecutionStep[] => slice.liveExecutionSteps,
);

export const selectLiveAgentActivity = createSelector(
  selectAgentPlaygroundSlice,
  (slice): PlaygroundAgentActivity[] => slice.liveAgentActivity,
);

export const selectLastRunMetrics = createSelector(
  selectAgentPlaygroundSlice,
  (slice): PlaygroundRunMetrics | null => slice.lastRunMetrics,
);

export const selectIsStreaming = createSelector(
  selectAgentPlaygroundSlice,
  (slice): boolean => slice.isStreaming,
);

export const selectPlaygroundSessionId = createSelector(
  selectAgentPlaygroundSlice,
  (slice): string | null => slice.sessionId,
);
