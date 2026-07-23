import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type { AgentStreamDonePayload } from "@/routes/pages/agents/api/agents.types";
import {
  buildExecutionStepFromToolCall,
  buildExecutionStepsFromAgentTrace,
} from "@/routes/pages/agents/playground/agent-playground-execution.utils";
import type {
  PlaygroundChatMessage,
  PlaygroundExecutionStep,
} from "@/routes/pages/agents/playground/agent-playground.types";
import type { AgentSseAgentCompletedEvent, AgentSseAgentStartedEvent } from "@/routes/pages/agents/api/agents.types";
import {
  AGENT_PLAYGROUND_SLICE_NAME,
  initialAgentPlaygroundState,
} from "./model";

type StreamStartedPayload = {
  userMessageId: string;
  assistantMessageId: string;
  text: string;
};

type AssistantTextAppendedPayload = {
  assistantMessageId: string;
  text: string;
};

type ToolCallResultedPayload = {
  toolCallId: string;
  result: unknown;
  elapsedMs?: number;
};

type RunCompletedPayload = {
  assistantMessageId: string;
  done: AgentStreamDonePayload;
};

type AssistantMessageRefPayload = {
  assistantMessageId: string;
};

type StreamFailedPayload = AssistantMessageRefPayload & {
  // Optional server-provided reason (e.g. a 413 context-window message). When
  // present it replaces the generic fallback copy so the failure is actionable.
  message?: string;
};

type StreamErroredPayload = {
  assistantMessageId: string;
  message: string;
};

type AgentTurnStartedPayload = AgentSseAgentStartedEvent["data"];
type AgentTurnCompletedPayload = AgentSseAgentCompletedEvent["data"];

function totalTokensOf(usage: AgentStreamDonePayload["usage"]): number {
  return (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
}

export const agentPlaygroundSlice = createSlice({
  name: AGENT_PLAYGROUND_SLICE_NAME,
  initialState: initialAgentPlaygroundState,
  reducers: {
    // Seeds the transcript with the user's message and an empty, streaming
    // assistant placeholder, and clears the previous run's tool timeline.
    streamStarted(state, action: PayloadAction<StreamStartedPayload>) {
      const { userMessageId, assistantMessageId, text } = action.payload;
      state.messages.push({ id: userMessageId, role: "user", content: text });
      state.messages.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
        isStreaming: true,
      });
      state.liveExecutionSteps = [];
      state.liveAgentActivity = [];
      state.isStreaming = true;
    },

    // A team participant began its turn — append a running entry so the UI can
    // show which agent is active. Dedupe defensively on a still-running turn.
    agentTurnStarted(state, action: PayloadAction<AgentTurnStartedPayload>) {
      const { agentName, startedAt } = action.payload;
      const alreadyRunning = state.liveAgentActivity.some(
        (a) => a.agentName === agentName && a.status === "running",
      );
      if (!alreadyRunning) {
        state.liveAgentActivity.push({ agentName, status: "running", startedAt });
      }
    },

    // A team participant finished — mark its most recent running turn complete.
    // Falls back to appending a completed entry if no running turn was recorded
    // (e.g. the started event was missed).
    agentTurnCompleted(state, action: PayloadAction<AgentTurnCompletedPayload>) {
      const { agentName, completedAt, durationMs } = action.payload;
      for (let i = state.liveAgentActivity.length - 1; i >= 0; i -= 1) {
        const entry = state.liveAgentActivity[i];
        if (entry.agentName === agentName && entry.status === "running") {
          entry.status = "completed";
          entry.completedAt = completedAt;
          entry.durationMs = durationMs;
          return;
        }
      }
      state.liveAgentActivity.push({
        agentName,
        status: "completed",
        completedAt,
        durationMs,
      });
    },

    assistantTextAppended(state, action: PayloadAction<AssistantTextAppendedPayload>) {
      const { assistantMessageId, text } = action.payload;
      const message = state.messages.find((m) => m.id === assistantMessageId);
      if (message) {
        message.content += text;
      }
    },

    toolCallStarted(state, action: PayloadAction<PlaygroundExecutionStep>) {
      state.liveExecutionSteps.push(action.payload);
    },

    // Rebuilds the matching step from its running snapshot so KB-retrieval
    // parsing and display naming stay identical to the start event.
    toolCallResulted(state, action: PayloadAction<ToolCallResultedPayload>) {
      const { toolCallId, result, elapsedMs } = action.payload;
      state.liveExecutionSteps = state.liveExecutionSteps.map((step) =>
        step.toolCallId === toolCallId
          ? buildExecutionStepFromToolCall(
              toolCallId,
              step.toolName,
              step.args,
              result,
              "completed",
              elapsedMs,
            )
          : step,
      );
    },

    runCompleted(state, action: PayloadAction<RunCompletedPayload>) {
      const { assistantMessageId, done } = action.payload;
      const totalTokens = totalTokensOf(done.usage);
      const usage = done.usage
        ? {
            promptTokens: done.usage.promptTokens,
            completionTokens: done.usage.completionTokens,
            totalTokens,
          }
        : undefined;

      // MAF bundles tool executions in the final `completed` event rather than
      // streaming incremental tool events, so `liveExecutionSteps` is empty for
      // MAF agents. Derive the Execution-tab steps from the agent trace here so
      // the just-finished run renders its tool calls without a persisted reload.
      const executionSteps = buildExecutionStepsFromAgentTrace(
        done.provenance?.agentTrace,
      );

      state.sessionId = done.sessionId;
      state.lastRunMetrics = {
        sessionId: done.sessionId,
        traceId: done.traceId,
        latencyMs: done.latencyMs,
        modelName: done.modelName ?? undefined,
        usage,
        citations: done.citations ?? undefined,
        modelConfig: done.modelConfig,
        toolStats: done.toolStats,
        kbStats: done.kbStats,
        provenance: done.provenance,
        executionSteps: executionSteps.length > 0 ? executionSteps : undefined,
      };

      const message = state.messages.find((m) => m.id === assistantMessageId);
      if (message) {
        message.isStreaming = false;
        message.latencyMs = done.latencyMs;
        message.modelName = done.modelName ?? undefined;
        message.usage = usage;
        message.citations = done.citations ?? undefined;
      }
    },

    streamErrored(state, action: PayloadAction<StreamErroredPayload>) {
      const { assistantMessageId, message } = action.payload;
      const target = state.messages.find((m) => m.id === assistantMessageId);
      if (target) {
        target.content = `Error: ${message}`;
        target.isStreaming = false;
      }
    },

    // Network/transport failure (the stream threw before a terminal event).
    streamFailed(state, action: PayloadAction<StreamFailedPayload>) {
      const target = state.messages.find((m) => m.id === action.payload.assistantMessageId);
      if (target) {
        target.content = action.payload.message?.trim()
          ? `Failed to get a response: ${action.payload.message.trim()}`
          : "Failed to get a response. Please try again.";
        target.isStreaming = false;
      }
    },

    streamEnded(state) {
      state.isStreaming = false;
    },

    playgroundReset() {
      return initialAgentPlaygroundState;
    },

    sessionLoaded(
      state,
      action: PayloadAction<{ messages: PlaygroundChatMessage[]; sessionId: string }>,
    ) {
      state.messages = action.payload.messages;
      state.sessionId = action.payload.sessionId;
      state.liveExecutionSteps = [];
      state.lastRunMetrics = null;
      state.isStreaming = false;
    },
  },
});

export const {
  streamStarted,
  assistantTextAppended,
  toolCallStarted,
  toolCallResulted,
  agentTurnStarted,
  agentTurnCompleted,
  runCompleted,
  streamErrored,
  streamFailed,
  streamEnded,
  playgroundReset,
  sessionLoaded,
} = agentPlaygroundSlice.actions;

export const agentPlaygroundReducer = agentPlaygroundSlice.reducer;
