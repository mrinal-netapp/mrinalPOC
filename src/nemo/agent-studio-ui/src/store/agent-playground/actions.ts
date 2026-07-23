import type { AppDispatch, RootState } from "@/store/store.types";

import { streamAgentInvoke } from "@/routes/pages/agents/api/agent-stream.service";
import {
  buildAgentStreamUrl,
  buildAgentTeamStreamUrl,
  type RuntimeQueryParams,
} from "@/routes/pages/agents/api/agents-api.paths";
import {
  agentsRuntimeApi,
  invalidateAgentSessionsCache,
} from "@/routes/pages/agents/api/agents-runtime-api.slice";
import { isTeamAgentId } from "@/routes/pages/agents/utils/agents-api-mapper";
import type {
  AgentInvokeRequest,
  AgentStreamInvokeRequest,
} from "@/routes/pages/agents/api/agents.types";
import { buildExecutionStepFromToolCall } from "@/routes/pages/agents/playground/agent-playground-execution.utils";
import type { PlaygroundInteractionMode } from "@/routes/pages/agents/playground/agent-playground.utils";
import { AGENT_PLAYGROUND_SLICE_NAME } from "./model";
import {
  agentTurnCompleted,
  agentTurnStarted,
  assistantTextAppended,
  runCompleted,
  streamEnded,
  streamErrored,
  streamFailed,
  streamStarted,
  toolCallResulted,
  toolCallStarted,
} from "./reducer";

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// The AbortController is intentionally module-level rather than in Redux state:
// it is non-serialisable and only the thunk needs it. A new send aborts the
// previous controller; `cancelAgentStream` (dispatched on unmount / agent
// change) aborts the active one.
let activeController: AbortController | null = null;

/** Playground invokes bypass config-service / bundle caches on the runtime. */
const PLAYGROUND_INVOKE_QUERY_PARAMS: RuntimeQueryParams = { staging: "playground" };

/**
 * Sends a user message and streams the agent's response into the playground
 * slice. No-op when `agentId` is null (create mode) or a stream is already in
 * flight. All SSE concerns are delegated to `agent-stream.service`; this thunk
 * only translates events into pure reducer actions and manages the abort
 * lifecycle.
 */
export const sendAgentMessage =
  (
    agentId: string | null,
    text: string,
    overrides?: { modelId?: string; interactionMode?: PlaygroundInteractionMode },
  ) =>
  (dispatch: AppDispatch, getState: () => RootState): void => {
    if (!agentId || getState()[AGENT_PLAYGROUND_SLICE_NAME].isStreaming) {
      return;
    }

    // Cancel any previous in-flight stream before starting a new one.
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    const userMessageId = generateMessageId();
    const assistantMessageId = generateMessageId();
    dispatch(streamStarted({ userMessageId, assistantMessageId, text }));

    // Single-turn agents (memoryType "none") have no server-side memory, so a
    // session id is never threaded — every message starts a fresh conversation.
    // Multi-turn agents carry the latest session id so history is preserved.
    const carrySession = overrides?.interactionMode !== "single-turn";
    const threadedSessionId = carrySession
      ? (getState()[AGENT_PLAYGROUND_SLICE_NAME].sessionId ?? undefined)
      : undefined;

    const request: AgentStreamInvokeRequest = {
      input: text,
      sessionId: threadedSessionId,
      ...(overrides?.modelId ? { configOverrides: { model: overrides.modelId } } : {}),
    };

    // Team agents (`agr-` ids) stream from the `/agent-teams/...` endpoint;
    // single agents (`ag-`) from `/agents/...`.
    const projectId = getState().projectContext.activeProject.id;
    const isSingleAgent = !isTeamAgentId(agentId);
    const url = isSingleAgent
      ? buildAgentStreamUrl(agentId, projectId, PLAYGROUND_INVOKE_QUERY_PARAMS)
      : buildAgentTeamStreamUrl(agentId, projectId, PLAYGROUND_INVOKE_QUERY_PARAMS);

    // Maps toolCallId → start timestamp so elapsed time can be computed on result.
    const toolCallStarts = new Map<string, number>();

    // Tracks whether the stream produced any assistant text. If it failed at the
    // transport layer before emitting anything, we can safely retry the request
    // via the non-streaming REST endpoint without risking duplicate output.
    let receivedAssistantText = false;

    // Falls back to the non-streaming `/agents/{id}/invoke` endpoint when the SSE
    // transport fails before producing output. Single agents only — there is no
    // REST invoke equivalent for teams. Returns true if it populated a response.
    const tryRestFallback = async (): Promise<boolean> => {
      if (!isSingleAgent || receivedAssistantText || controller.signal.aborted) {
        return false;
      }
      try {
        const body: AgentInvokeRequest = {
          input: text,
          sessionId: threadedSessionId ?? null,
          ...(overrides?.modelId ? { configOverrides: { model: overrides.modelId } } : {}),
        };
        const result = await dispatch(
          agentsRuntimeApi.endpoints.invokeAgent.initiate({
            agentId,
            body,
            queryParams: PLAYGROUND_INVOKE_QUERY_PARAMS,
          }),
        ).unwrap();

        dispatch(assistantTextAppended({ assistantMessageId, text: result.response }));
        dispatch(
          runCompleted({
            assistantMessageId,
            done: {
              sessionId: result.sessionId,
              latencyMs: result.latencyMs,
              modelName: result.modelName,
              usage: result.usage,
              citations: result.citations,
              traceId: result.traceId,
            },
          }),
        );
        // The session LIST + detail caches are invalidated by `invokeAgent`'s
        // own `invalidatesTags`; no manual invalidation needed on this path.
        return true;
      } catch {
        return false;
      }
    };

    void (async () => {
      try {
        for await (const event of streamAgentInvoke(url, request, controller.signal)) {
          if (controller.signal.aborted) {
            break;
          }

          switch (event.type) {
            case "message": {
              receivedAssistantText = true;
              dispatch(assistantTextAppended({ assistantMessageId, text: event.data }));
              break;
            }

            case "tool_call_start": {
              const { toolCallId, toolName, args } = event.data;
              toolCallStarts.set(toolCallId, Date.now());
              dispatch(
                toolCallStarted(
                  buildExecutionStepFromToolCall(toolCallId, toolName, args, undefined, "running"),
                ),
              );
              break;
            }

            case "tool_call_result": {
              const { toolCallId, result } = event.data;
              const startedAt = toolCallStarts.get(toolCallId);
              const elapsedMs = startedAt !== undefined ? Date.now() - startedAt : undefined;
              dispatch(toolCallResulted({ toolCallId, result, elapsedMs }));
              break;
            }

            case "agent_started": {
              dispatch(agentTurnStarted(event.data));
              break;
            }

            case "agent_completed": {
              dispatch(agentTurnCompleted(event.data));
              break;
            }

            case "done": {
              dispatch(runCompleted({ assistantMessageId, done: event.data }));
              // SSE is consumed in this thunk, not via an RTK Query mutation, so
              // there is no `invalidatesTags` to lean on — invalidate the session
              // LIST + detail caches here so the dropdown picks up the new run.
              if (event.data.sessionId) {
                invalidateAgentSessionsCache(dispatch, agentId, event.data.sessionId);
              }
              break;
            }

            case "error": {
              dispatch(streamErrored({ assistantMessageId, message: event.data }));
              break;
            }
          }
        }
      } catch (err) {
        // Transport failure (the stream threw before a terminal event). Try the
        // REST endpoint; only show the failure message if that also fails.
        // Teams have no REST fallback, so the stream error (e.g. a 413
        // context-window message from the service) is surfaced as-is.
        if (!controller.signal.aborted) {
          const recovered = await tryRestFallback();
          if (!recovered) {
            const message = err instanceof Error ? err.message : undefined;
            dispatch(streamFailed({ assistantMessageId, message }));
          }
        }
      } finally {
        if (activeController === controller) {
          activeController = null;
        }
        dispatch(streamEnded());
      }
    })();
  };

/** Aborts the in-flight stream, if any. Safe to call when nothing is streaming. */
export const cancelAgentStream =
  () =>
  (dispatch: AppDispatch): void => {
    activeController?.abort();
    activeController = null;
    dispatch(streamEnded());
  };
