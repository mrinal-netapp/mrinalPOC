import type {
  PlaygroundAgentActivity,
  PlaygroundChatMessage,
  PlaygroundExecutionStep,
  PlaygroundRunMetrics,
} from "@/routes/pages/agents/playground/agent-playground.types";

export const AGENT_PLAYGROUND_SLICE_NAME = "agentPlayground" as const;

/**
 * Playground streaming state for the active agent chat session.
 *
 * This is the single source of truth for an in-flight (or just-completed) agent
 * invocation. The SSE transport and the consumption loop live in the thunk layer
 * (`actions.ts`); reducers here only apply pure, serialisable updates per event.
 *
 * Only one playground is ever interactive at a time (either the workspace page
 * or the create/edit form's inline playground — different routes), so a single
 * slice is sufficient. Consumers dispatch `playgroundReset` on mount / agent
 * change so a new session never shows a previous agent's transcript.
 */
export interface AgentPlaygroundState {
  /** Ordered chat transcript (user + assistant messages). */
  messages: PlaygroundChatMessage[];
  /** Tool-call timeline for the current run; cleared at the start of each run. */
  liveExecutionSteps: PlaygroundExecutionStep[];
  /**
   * Live per-agent turn timeline for a team run (from agent_started /
   * agent_completed); cleared at the start of each run. Empty for single agents.
   */
  liveAgentActivity: PlaygroundAgentActivity[];
  /** Metrics from the most recently completed run (`done` event). */
  lastRunMetrics: PlaygroundRunMetrics | null;
  /** True while an SSE stream is in flight. */
  isStreaming: boolean;
  /** Session ID from the latest `done` event — threaded into the next request. */
  sessionId: string | null;
}

export const initialAgentPlaygroundState: AgentPlaygroundState = {
  messages: [],
  liveExecutionSteps: [],
  liveAgentActivity: [],
  lastRunMetrics: null,
  isStreaming: false,
  sessionId: null,
};
