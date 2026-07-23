import { describe, expect, it } from "vitest";

import type { RootState } from "@/store/store.types";

import { initialAgentsState, type AgentsState } from "./model";
import {
  selectActiveTab,
  selectSingleDeprecatedIds,
  selectTeamDeprecatedIds,
} from "./selectors";

function rootWith(agents: AgentsState): RootState {
  return { agents } as unknown as RootState;
}

describe("agents selectors", () => {
  it("[tag:agents-store] selectActiveTab reads the active tab", () => {
    const state = rootWith({ ...initialAgentsState, activeTab: "team" });
    expect(selectActiveTab(state)).toBe("team");
  });

  it("[tag:agents-store] selectSingleDeprecatedIds reads the single ids", () => {
    const state = rootWith({ ...initialAgentsState, singleDeprecatedIds: ["a1"] });
    expect(selectSingleDeprecatedIds(state)).toEqual(["a1"]);
  });

  it("[tag:agents-store] selectTeamDeprecatedIds reads the team ids", () => {
    const state = rootWith({ ...initialAgentsState, teamDeprecatedIds: ["t1"] });
    expect(selectTeamDeprecatedIds(state)).toEqual(["t1"]);
  });
});
