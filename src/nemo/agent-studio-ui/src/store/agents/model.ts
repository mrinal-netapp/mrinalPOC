export type AgentsTabId = "single" | "team";

/** Discriminates which deprecation list a `setAgentDeprecated` / `clearAgentDeprecated` action targets. */
export type AgentKind = "single" | "team";

/**
 * Agents UI-state — client-only state that must survive route changes
 * (list <-> detail <-> playground). Server data (agent lists, details,
 * sessions) lives in RTK Query (`agentsConfigApi` / `agentsRuntimeApi`) and is
 * never duplicated here (ST-004).
 */
export interface AgentsState {
  /** Active list tab; persists when navigating to a detail page and back. */
  activeTab: AgentsTabId;
  /**
   * Client-side deprecation flags shared between the list and detail pages.
   * The backend has no `deprecated` field yet, so these live in Redux until
   * the API adds support (at which point they become `updateAgentStatus`
   * calls).
   */
  singleDeprecatedIds: string[];
  teamDeprecatedIds: string[];
}

export const AGENTS_SLICE_NAME = "agents" as const;

export const initialAgentsState: AgentsState = {
  activeTab: "single",
  singleDeprecatedIds: [],
  teamDeprecatedIds: [],
};
