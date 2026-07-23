import { describe, expect, it } from "vitest";

import type { Agent } from "@/routes/pages/agents/api/agents.types";
import {
  agentToDisplayConfig,
  buildAgentUpdateFromConfigureForm,
  formatPlaygroundLatency,
  formatPlaygroundModelLabel,
  formatPlaygroundToolStatus,
  formatPlaygroundTotalTokens,
  hasPlaygroundMessageMetadata,
  isAgentDetailPending,
  memoryTypeToPlaygroundMode,
  playgroundModeToMemoryType,
} from "./agent-playground.utils";
import type { PlaygroundChatMessage } from "./agent-playground.types";

const KB_ID = "kb1";

const baseAgent: Agent = {
  id: "ag-1",
  name: "test-agent",
  role: "assistant",
  systemPrompt: "You are helpful.",
  temperature: 0.5,
  maxTokens: 1024,
  memoryType: "conversation",
  ragConfig: { [KB_ID]: { topK: 8, similarityThreshold: 0.5, searchMode: "hybrid" } },
};

describe("agent-playground.utils", () => {
  it("[tag:agents] maps memory types to playground modes", () => {
    expect(memoryTypeToPlaygroundMode("none")).toBe("single-turn");
    expect(memoryTypeToPlaygroundMode("conversation")).toBe("multi-turn");
    expect(playgroundModeToMemoryType("single-turn")).toBe("none");
    expect(playgroundModeToMemoryType("multi-turn")).toBe("conversation");
  });

  it("[tag:agents] builds display config from agent", () => {
    const display = agentToDisplayConfig(baseAgent, [{ id: "m1", displayName: "GPT-4" }], 0.4);
    expect(display.agentName).toBe("test-agent");
    expect(display.topKChunks).toBe(8);
    expect(display.topP).toBe(0.4);
    expect(display.mode).toBe("multi-turn");
  });

  it("[tag:agents] detects pending agent detail fetch", () => {
    expect(isAgentDetailPending("ag-1", baseAgent, false, false)).toBe(false);
    expect(isAgentDetailPending("ag-1", undefined, true, false)).toBe(true);
    expect(isAgentDetailPending("ag-2", baseAgent, false, false)).toBe(true);
    expect(isAgentDetailPending("ag-1", baseAgent, false, true)).toBe(true);
  });

  it("[tag:agents] formats tool execution status labels", () => {
    expect(formatPlaygroundToolStatus("executed")).toBe("Executed");
    expect(formatPlaygroundToolStatus("")).toBe("—");
  });

  it("[tag:agents] formats chat legend labels", () => {
    expect(formatPlaygroundLatency(255)).toBe("255 ms");
    expect(formatPlaygroundTotalTokens(2190)).toBe("2,190");
    expect(formatPlaygroundModelLabel("gpt-4o")).toBe("GPT-4o");
    expect(
      formatPlaygroundModelLabel("azure/proj_cred_gpt-4", [
        {
          id: "m1",
          name: "Production GPT-4",
          displayName: "GPT-4 Production",
          providerModelId: "gpt-4",
          gatewayModelId: "azure/proj_cred_gpt-4",
        },
      ]),
    ).toBe("GPT-4 Production");
  });

  it("[tag:agents] detects when assistant messages should show metadata", () => {
    const streaming: PlaygroundChatMessage = {
      id: "1",
      role: "assistant",
      content: "Hi",
      isStreaming: true,
      latencyMs: 10,
    };
    const completed: PlaygroundChatMessage = {
      id: "2",
      role: "assistant",
      content: "Hi",
      usage: { totalTokens: 12 },
    };

    expect(hasPlaygroundMessageMetadata(streaming)).toBe(false);
    expect(hasPlaygroundMessageMetadata(completed)).toBe(true);
  });

  it("[tag:agents] builds update payload from configure form", () => {
    const body = buildAgentUpdateFromConfigureForm(baseAgent, {
      mode: "single-turn",
      instructions: "New prompt",
      temperature: 0.2,
      topK: 5,
      tokenLimit: 2048,
    });
    expect(body.systemPrompt).toBe("New prompt");
    expect(body.memoryType).toBe("none");
    expect(body.ragConfig?.[KB_ID]?.topK).toBe(5);
  });
});
