/**
 * Public surface of the agents Redux UI slice (FS-002 split:
 * `model.ts` / `reducer.ts` / `selectors.ts` / `index.ts`).
 *
 * The slice holds only client-side UI state that must survive route changes
 * (active list tab, client-side deprecation flags). Server data lives in RTK
 * Query (`@/routes/pages/agents/api/agents-config-api.slice`, `@/routes/pages/agents/api/agents-runtime-api.slice`)
 * and is never duplicated here (ST-004).
 *
 * There is intentionally no `actions.ts` (thunk layer): the slice has no
 * side-effecting async actions today — all server writes go through RTK Query
 * mutations. Add `actions.ts` here if a cross-cutting thunk becomes necessary.
 */
export {
  agentsSlice,
  agentsReducer,
  setActiveTab,
  setAgentDeprecated,
  clearAgentDeprecated,
} from "./reducer";

export {
  selectActiveTab,
  selectSingleDeprecatedIds,
  selectTeamDeprecatedIds,
} from "./selectors";

export {
  AGENTS_SLICE_NAME,
  initialAgentsState,
  type AgentsState,
  type AgentsTabId,
  type AgentKind,
} from "./model";
