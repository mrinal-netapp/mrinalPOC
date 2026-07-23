import { describe, expect, it } from "vitest";

import type { AgentTraceSpan } from "@/routes/pages/agents/api/agents.types";
import { buildPlaygroundRunStatistics } from "./agent-playground-statistics.utils";
import type { PlaygroundRunMetrics } from "./agent-playground.types";
import { agentToDisplayConfig } from "./agent-playground.utils";

const baseMetrics: PlaygroundRunMetrics = {
  sessionId: "session-1",
  latencyMs: 255,
  usage: {
    promptTokens: 1722,
    completionTokens: 468,
    totalTokens: 2190,
  },
  kbStats: [
    {
      knowledgeBaseId: "kb-1",
      knowledgeBaseName: "Product Docs",
      retrievedChunks: 3,
      tokensUsed: 711,
    },
    {
      knowledgeBaseId: "kb-2",
      knowledgeBaseName: "Support Docs",
      retrievedChunks: 5,
      tokensUsed: 200,
    },
  ],
  toolStats: [
    {
      toolName: "get_volume_metrics",
      serverName: "volume-toolset",
      serverId: "mcp-1",
      status: "executed",
      latencyMs: 340,
    },
    {
      toolName: "check_service_level",
      serverName: "volume-toolset",
      serverId: "mcp-1",
      status: "executed",
      latencyMs: 120,
    },
  ],
  modelConfig: {
    maxTokens: 4096,
  },
  citations: [
    { score: 0.9 },
    { score: 0.8 },
  ],
};

const llmSpan: AgentTraceSpan = {
  id: "llm",
  name: "llm.call",
  context: { span_id: "llm-span" },
  start_time: "2026-05-19T10:00:01.000Z",
  end_time: "2026-05-19T10:00:04.025Z",
  attributes: {
    "llm.model_name": "gpt-4o",
    "gen_ai.response.time_to_first_token_ms": 380,
  },
};

describe("agent-playground-statistics.utils", () => {
  it("[tag:agents] returns empty view model when metrics are unavailable", () => {
    const viewModel = buildPlaygroundRunStatistics(null, [], null);
    expect(viewModel.isEmpty).toBe(true);
    expect(viewModel.sections).toEqual([]);
  });

  it("[tag:agents] builds grouped statistics from stream done payload and trace spans", () => {
    const displayConfig = agentToDisplayConfig(
      {
        id: "agent-1",
        name: "Agent",
        role: "assistant",
        systemPrompt: "You are helpful.",
        maxTokens: 4096,
      },
      [],
    );

    const viewModel = buildPlaygroundRunStatistics(baseMetrics, [llmSpan], displayConfig);
    const timing = viewModel.sections.find((section) => section.title === "Timing");
    const tokens = viewModel.sections.find((section) => section.title === "Tokens");
    const retrieval = viewModel.sections.find((section) => section.title === "Retrieval performance");
    const tools = viewModel.sections.find((section) => section.title === "Tool execution");

    expect(viewModel.isEmpty).toBe(false);
    expect(timing?.rows).toEqual([
      { label: "Latency", value: "255 ms" },
      { label: "Time to First Token", value: "380 ms" },
      { label: "Generation time", value: "3025 ms" },
    ]);
    expect(tokens?.rows).toEqual([
      { label: "Total tokens", value: "2,190" },
      { label: "Input tokens", value: "1,722" },
      { label: "Output tokens", value: "468" },
    ]);
    expect(retrieval?.rows).toEqual([
      { label: "Chunks found", value: "8" },
      { label: "Average relevance", value: "85%" },
      { label: "Context window usage", value: "22%" },
    ]);
    expect(tools?.rows).toEqual([
      { label: "Success rate", value: "100%" },
      { label: "Executed successfully", value: "2/2" },
    ]);
  });

  it("[tag:agents] averages relevance from per-tool kbCitations in provenance", () => {
    const metrics: PlaygroundRunMetrics = {
      sessionId: "session-maf",
      // Flat top-level citations are the unscored aggregate MAF emits; the
      // scored chunks live on each tool execution and must drive the average.
      citations: [{ source: "plan-and-prepare-service-perimeter.txt" }],
      provenance: {
        agentTrace: [
          {
            agentName: "GCNV_Agent",
            toolExecutions: [
              {
                toolName: "kb_retrieve",
                toolType: "kb",
                kbCitations: [
                  { score: 0.961166253101737 },
                  { score: 0.8848013453857473 },
                  { score: 0.8446333078686019 },
                  { score: 0.5 },
                  { score: 0.5 },
                ],
              },
            ],
          },
        ],
      },
    };

    const viewModel = buildPlaygroundRunStatistics(metrics, [], null);
    const retrieval = viewModel.sections.find(
      (section) => section.title === "Retrieval performance",
    );

    expect(
      retrieval?.rows.find((row) => row.label === "Average relevance")?.value,
    ).toBe("74%");
  });

  it("[tag:agents] leaves unavailable cost and timing fields empty", () => {
    const viewModel = buildPlaygroundRunStatistics(
      {
        sessionId: "session-1",
        latencyMs: 120,
      },
      [],
      null,
    );

    const cost = viewModel.sections.find((section) => section.title === "Cost");
    const timing = viewModel.sections.find((section) => section.title === "Timing");

    expect(cost?.rows.every((row) => row.value === "")).toBe(true);
    expect(timing?.rows).toEqual([
      { label: "Latency", value: "120 ms" },
      { label: "Time to First Token", value: "" },
      { label: "Generation time", value: "" },
    ]);
  });
});
