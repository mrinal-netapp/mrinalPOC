/**
 * Public surface of the agent-playground Redux slice (FS-002 split:
 * `model.ts` / `reducer.ts` / `selectors.ts` / `actions.ts` / `index.ts`).
 *
 * Holds the live streaming chat state for the active agent. The SSE transport
 * lives in `@/routes/pages/agents/api/agent-stream.service`; this slice owns
 * only the serialisable view of an in-flight/just-completed run. Components
 * dispatch `sendAgentMessage` / `cancelAgentStream` / `playgroundReset` and read
 * state through the selectors below — never via a custom state hook.
 */
export {
  agentPlaygroundSlice,
  agentPlaygroundReducer,
  playgroundReset,
  sessionLoaded,
} from "./reducer";

export { sendAgentMessage, cancelAgentStream } from "./actions";

export {
  selectPlaygroundMessages,
  selectLiveExecutionSteps,
  selectLiveAgentActivity,
  selectLastRunMetrics,
  selectIsStreaming,
  selectPlaygroundSessionId,
} from "./selectors";

export {
  AGENT_PLAYGROUND_SLICE_NAME,
  initialAgentPlaygroundState,
  type AgentPlaygroundState,
} from "./model";
