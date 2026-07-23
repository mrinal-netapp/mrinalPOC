import { ROUTES } from "@/routes/routes.consts";

export const AGENTS_STRINGS = {
  PAGE_TITLE: "Agents",
  PAGE_SUBTITLE: "Create and manage AI agents to automate your workflows.",
  TAB_SINGLE: "Single agents",
  TAB_TEAM: "Team",
  ROW_LABEL_SINGLE: "Single agents",
  ROW_LABEL_TEAM: "Team agents",
  PRIMARY_ACTION: "Add",
  PRIMARY_ACTION_SINGLE_FEEDBACK: "Add single agent",
  PRIMARY_ACTION_TEAM_FEEDBACK: "Add team agent",
  SECONDARY_ACTION_PLAYGROUND: "Playground",
  ASSOCIATED_RESOURCES: "Associated resources",
  ASSOCIATED_AGENTS: "Associated agents",
  TABS_ARIA_LABEL: "Agents tabs",
  // -- Playground strings --
  CHAT_REQUIRES_AGENT: "Agent is not available for chat.",
  CHAT_STARTING: "Starting…",
  OUTPUT_DETAILS_TITLE: "Run details",
  OUTPUT_DETAILS_EMPTY: "You haven't submitted the chat message",
  NEW_CONVERSATION: "New Conversation",
  SHOW_OUTPUT_DETAILS: "Show details",
  HIDE_OUTPUT_DETAILS: "Hide details",
  EXECUTION_STEP_LABEL: "Step",
  EXECUTION_STATUS_COMPLETED: "Completed",
  EXECUTION_STATUS_RUNNING: "Running",
  EXECUTION_STATUS_FAILED: "Failed",
  EXECUTION_STEP_STATUS_LABEL: "Status",
  EXECUTION_STEP_ELAPSED_LABEL: "Elapsed time",
  EXECUTION_STEP_TOOL_CALL_ID_LABEL: "Tool call ID",
  EXECUTION_STEP_ARGS_LABEL: "Arguments",
  EXECUTION_STEP_RESULT_LABEL: "Result",
  EXECUTION_RESULT_EMPTY: "No details returned for this step.",
  EXECUTION_EMPTY_NO_STEPS: "No tool calls were captured for this run.",
  RUN_DETAILS_LOADING: "Loading…",
  EXECUTION_KB_RETRIEVAL_STEP_NAME: "Knowledge base retrieval",
  EXECUTION_KB_DETAILS_SECTION_TITLE: "Retrieval details",
  EXECUTION_KB_LABEL: "Knowledge base",
  EXECUTION_KB_TOP_K_LABEL: "Top K",
  EXECUTION_KB_TOTAL_CONTEXT_LABEL: "Total retrieved context",
  EXECUTION_KB_QUERY_LABEL: "Query",
  EXECUTION_KB_CHUNKS_LABEL: "Retrieved chunks",
  EXECUTION_KB_LOGS_LABEL: "Logs",
  EXECUTION_KB_SHOW_MORE: "Show more",
  EXECUTION_KB_COPY_LOGS: "Copy logs",
  EXECUTION_KB_UNKNOWN: "—",
  EXECUTION_KB_NO_CHUNKS: "No retrieved chunks.",
  TRACING_EMPTY_NO_STEPS: "No trace spans were captured for this run.",
  TRACING_SPAN_KIND_LABEL: "Span Kind",
  TRACING_INPUT_LABEL: "Input",
  TRACING_OUTPUT_LABEL: "Output",
  TRACING_INPUT_OUTPUT_EMPTY: "No value recorded for this step.",
  TRACING_SHOW_MORE: "Show more",
  TRACING_SHOW_LESS: "Show less",
  TRACING_COPY_INPUT: "Copy input",
  TRACING_COPY_OUTPUT: "Copy output",
} as const;

// Row-actions menu labels + the toast messages each click emits.
export const AGENTS_LIST_STRINGS = {
  ACTION_VIEW_DETAILS: "View details",
  ACTION_DRAFT: "Draft",
  ACTION_DRAFT_FEEDBACK_PREFIX: "Drafting",
  DRAFT_SUCCESS_SUFFIX: "moved to draft.",
  DRAFT_FAILURE_PREFIX: "Failed to draft",
  DRAFT_MISSING_PROJECT_PREFIX: "Cannot draft",
  ACTION_DEPRECATE: "Deprecate",
  ACTION_UNDEPRECATE: "Undeprecate",
  ACTION_DEPLOY: "Deploy",
  ACTION_DEPLOY_FEEDBACK_PREFIX: "Deploying",
  DEPLOY_SUCCESS_SUFFIX: "deployed.",
  DEPLOY_FAILURE_PREFIX: "Failed to deploy",
  DEPLOY_MISSING_PROJECT_PREFIX: "Cannot deploy",
  ACTION_EDIT: "Edit",
  ACTION_EDIT_FEEDBACK_PREFIX: "Editing",
  ACTION_DELETE: "Delete",
  DELETE_AGENT_TITLE: "Delete agent",
  DELETE_TEAM_TITLE: "Delete team agent",
  DELETE_CONFIRM_LABEL: "Delete",
  DELETE_SUCCESS_PREFIX: "",
  DELETE_SUCCESS_SUFFIX: "deleted successfully.",
  DELETE_FAILURE_PREFIX: "Failed to delete",
  DELETE_MISSING_PROJECT_PREFIX: "Cannot delete",
  DELETE_MISSING_PROJECT_SUFFIX: "missing project context.",
} as const;

/** Strings for the create/edit agent form. */
export const AGENT_STRINGS = {
  PAGE_TITLE: "Add agent",
  PAGE_SUBTITLE: "Create AI agents to automate your workflows",
} as const;

/** Sentinel value for the run dropdown when starting a fresh session (no history loaded). */
export const NEW_CONVERSATION_SESSION_ID = "__new_conversation__";

export const AGENTS_TABS = [
  { id: "single", label: AGENTS_STRINGS.TAB_SINGLE },
  { id: "team", label: AGENTS_STRINGS.TAB_TEAM },
] as const;

/** Backend list endpoints default to limit=20; agents UI needs the full catalog. */
export const AGENTS_LIST_FETCH_LIMIT = 500;

// TEMP: Deploy actions are shown but locked until endpoint generation ships
// (form Save-and-deploy, list row Deploy, detail page Deploy). The lock is a
// TRUE lock, enforced in three layers: `aria-disabled` (assistive tech announces
// it), the `--locked` CSS class (greyed + `pointer-events: none` blocks the
// mouse), and — crucially — a JS guard (`isDeployActivationLocked`) on every
// deploy handler so keyboard (Enter/Space) and programmatic clicks are no-ops
// too. We intentionally do NOT use the framework `disabled` prop: Base UI's
// Menu.Item severs `onClick` when `disabled`, whereas keeping the handler wired
// + JS-guarded lets QA re-enable a single control in devtools (delete its
// `--locked` class) and exercise the real deploy flow during this short rollout.
// Set to false to fully restore deploy.
export const LOCK_AGENT_DEPLOY = true;

/** Marker class applied to locked deploy controls; also the JS-guard hook. */
export const DEPLOY_LOCKED_CLASS = "agent-deploy-action--locked";

/**
 * JS activation guard for the temporary deploy lock. Returns true (block the
 * deploy handler) when the lock is active AND the activated element still
 * carries the `--locked` marker class. Reading the live DOM — rather than the
 * const alone — is what makes the lock manually testable: QA can delete the
 * `--locked` class on a control in devtools and this guard stops blocking it,
 * so the real deploy flow can be exercised without a rebuild.
 */
export function isDeployActivationLocked(target: EventTarget | null): boolean {
  if (!LOCK_AGENT_DEPLOY) return false;
  // A non-Element target can't carry the `--locked` marker (so it can't be
  // unlocked in devtools); treat it as locked while the global lock is active.
  if (!(target instanceof Element)) return true;
  return target.closest(`.${DEPLOY_LOCKED_CLASS}`) != null;
}

// Re-exported from the Redux slice model so both the page and the store
// share exactly one definition.
export type { AgentsTabId } from "@/store";

const AGENT_BASE = `/${ROUTES.AGENTS}`;

/** All client-side navigation paths for the agents section. */
export const agentPaths = {
  root: AGENT_BASE,
  create: `${AGENT_BASE}/${ROUTES.CREATE}`,
  detail: (agentId: string): string => `${AGENT_BASE}/${agentId}`,
  edit: (agentId: string): string => `${AGENT_BASE}/${agentId}/${ROUTES.EDIT}`,
} as const;

/** @deprecated Use `agentPaths` instead. */
export const agentsPaths = agentPaths;
