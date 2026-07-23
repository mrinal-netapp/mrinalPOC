import { createSelector } from "@reduxjs/toolkit";

import type { RootState } from "@/store/store.types";

import { AGENTS_SLICE_NAME, type AgentsState, type AgentsTabId } from "./model";

const selectAgentsSlice = (state: RootState): AgentsState =>
  state[AGENTS_SLICE_NAME];

export const selectActiveTab = createSelector(
  selectAgentsSlice,
  (slice): AgentsTabId => slice.activeTab,
);

export const selectSingleDeprecatedIds = createSelector(
  selectAgentsSlice,
  (slice): string[] => slice.singleDeprecatedIds,
);

export const selectTeamDeprecatedIds = createSelector(
  selectAgentsSlice,
  (slice): string[] => slice.teamDeprecatedIds,
);
