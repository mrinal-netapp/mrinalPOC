import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import {
  AGENTS_SLICE_NAME,
  initialAgentsState,
  type AgentKind,
  type AgentsTabId,
} from "./model";

export const agentsSlice = createSlice({
  name: AGENTS_SLICE_NAME,
  initialState: initialAgentsState,
  reducers: {
    setActiveTab(state, action: PayloadAction<AgentsTabId>) {
      state.activeTab = action.payload;
    },
    /**
     * Mark an agent as deprecated (client-side until the API exposes a
     * `deprecated` field). Idempotent — adding the same id twice is a no-op.
     */
    setAgentDeprecated(
      state,
      action: PayloadAction<{ kind: AgentKind; id: string }>,
    ) {
      const list =
        action.payload.kind === "single"
          ? state.singleDeprecatedIds
          : state.teamDeprecatedIds;
      if (!list.includes(action.payload.id)) {
        list.push(action.payload.id);
      }
    },
    /**
     * Remove the deprecated flag from an agent. No-op for an unknown id.
     */
    clearAgentDeprecated(
      state,
      action: PayloadAction<{ kind: AgentKind; id: string }>,
    ) {
      if (action.payload.kind === "single") {
        state.singleDeprecatedIds = state.singleDeprecatedIds.filter(
          (id) => id !== action.payload.id,
        );
      } else {
        state.teamDeprecatedIds = state.teamDeprecatedIds.filter(
          (id) => id !== action.payload.id,
        );
      }
    },
  },
});

export const { setActiveTab, setAgentDeprecated, clearAgentDeprecated } =
  agentsSlice.actions;

export const agentsReducer = agentsSlice.reducer;
