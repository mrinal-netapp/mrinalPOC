import { describe, expect, it } from "vitest";

import { initialAgentsState } from "./model";
import {
  agentsReducer,
  setActiveTab,
  setAgentDeprecated,
  clearAgentDeprecated,
} from "./reducer";

describe("agents reducer", () => {
  it("[tag:agents-store] returns the initial state", () => {
    expect(agentsReducer(undefined, { type: "@@INIT" })).toEqual(initialAgentsState);
  });

  it("[tag:agents-store] setActiveTab switches the active tab", () => {
    const next = agentsReducer(undefined, setActiveTab("team"));
    expect(next.activeTab).toBe("team");
  });

  describe("single deprecation", () => {
    it("[tag:agents-store] setAgentDeprecated (single) adds an id and is idempotent", () => {
      let state = agentsReducer(undefined, setAgentDeprecated({ kind: "single", id: "a1" }));
      expect(state.singleDeprecatedIds).toEqual(["a1"]);
      state = agentsReducer(state, setAgentDeprecated({ kind: "single", id: "a1" }));
      expect(state.singleDeprecatedIds).toEqual(["a1"]);
    });

    it("[tag:agents-store] clearAgentDeprecated (single) removes only the matching id", () => {
      let state = agentsReducer(undefined, setAgentDeprecated({ kind: "single", id: "a1" }));
      state = agentsReducer(state, setAgentDeprecated({ kind: "single", id: "a2" }));
      state = agentsReducer(state, clearAgentDeprecated({ kind: "single", id: "a1" }));
      expect(state.singleDeprecatedIds).toEqual(["a2"]);
    });

    it("[tag:agents-store] clearAgentDeprecated (single) is a no-op for an unknown id", () => {
      const state = agentsReducer(undefined, clearAgentDeprecated({ kind: "single", id: "missing" }));
      expect(state.singleDeprecatedIds).toEqual([]);
    });
  });

  describe("team deprecation", () => {
    it("[tag:agents-store] setAgentDeprecated (team) adds an id and is idempotent", () => {
      let state = agentsReducer(undefined, setAgentDeprecated({ kind: "team", id: "t1" }));
      expect(state.teamDeprecatedIds).toEqual(["t1"]);
      state = agentsReducer(state, setAgentDeprecated({ kind: "team", id: "t1" }));
      expect(state.teamDeprecatedIds).toEqual(["t1"]);
    });

    it("[tag:agents-store] clearAgentDeprecated (team) removes only the matching id", () => {
      let state = agentsReducer(undefined, setAgentDeprecated({ kind: "team", id: "t1" }));
      state = agentsReducer(state, setAgentDeprecated({ kind: "team", id: "t2" }));
      state = agentsReducer(state, clearAgentDeprecated({ kind: "team", id: "t2" }));
      expect(state.teamDeprecatedIds).toEqual(["t1"]);
    });

    it("[tag:agents-store] single and team deprecation are independent", () => {
      let state = agentsReducer(undefined, setAgentDeprecated({ kind: "single", id: "a1" }));
      state = agentsReducer(state, setAgentDeprecated({ kind: "team", id: "t1" }));
      expect(state.singleDeprecatedIds).toEqual(["a1"]);
      expect(state.teamDeprecatedIds).toEqual(["t1"]);
    });

    it("[tag:agents-store] clearAgentDeprecated targets only the given kind", () => {
      let state = agentsReducer(undefined, setAgentDeprecated({ kind: "single", id: "shared-id" }));
      state = agentsReducer(state, setAgentDeprecated({ kind: "team", id: "shared-id" }));
      state = agentsReducer(state, clearAgentDeprecated({ kind: "single", id: "shared-id" }));
      expect(state.singleDeprecatedIds).toEqual([]);
      expect(state.teamDeprecatedIds).toEqual(["shared-id"]);
    });
  });
});
