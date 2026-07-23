import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@test/render";
import type { PlaygroundRunMetrics } from "../../agent-playground.types";
import type { AgentPlaygroundDisplayConfig } from "../../agent-playground.utils";
import { RunDetailsConfigurationTab } from "./run-details-configuration-tab";

const displayConfig: AgentPlaygroundDisplayConfig = {
  agentId: "ag-test",
  agentName: "Test Agent",
  mode: "single-turn",
  instructions: "Be helpful.",
  temperature: 0.5,
  topP: 0.8,
  topKChunks: 4,
  tokenLimit: 2000,
  modelDisplayName: "GPT-4o Mini",
};

const lastRunMetrics: PlaygroundRunMetrics = {
  sessionId: "sess-1",
  traceId: "trace-1",
  latencyMs: 100,
  modelName: "Run Model",
  modelConfig: {
    temperature: 0.2,
    topP: 0.1,
    topK: 3,
    maxTokens: 1500,
  },
  kbStats: [
    {
      knowledgeBaseId: "kb-1",
      knowledgeBaseName: "Product Docs",
      retrievedChunks: 2,
      tokensUsed: 500,
    },
  ],
  toolStats: [
    {
      toolName: "search",
      serverName: "MCP Server",
      serverId: "srv-1",
      status: "executed",
      latencyMs: 42,
    },
  ],
};

describe("RunDetailsConfigurationTab", () => {
  it("[tag:agents] prompts to send a message when no run metrics exist", () => {
    renderWithProviders(
      <RunDetailsConfigurationTab lastRunMetrics={null} displayConfig={displayConfig} />,
    );

    expect(
      screen.getByText("Send a message in Chat to see configuration for the latest run."),
    ).toBeInTheDocument();
  });

  it("[tag:agents] renders the run's own config when display config is missing", () => {
    renderWithProviders(
      <RunDetailsConfigurationTab lastRunMetrics={lastRunMetrics} displayConfig={null} />,
    );

    // displayConfig is only a fallback — the tab must still populate from the
    // completed run's metrics rather than blanking the whole panel.
    expect(
      screen.queryByText("Select an agent to view configuration."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Run Model")).toBeInTheDocument();
    expect(screen.getByText("0.2")).toBeInTheDocument();
    expect(screen.getByText("3 chunks")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
  });

  it("[tag:agents] falls back to em dash for model params absent from run and display config", () => {
    renderWithProviders(
      <RunDetailsConfigurationTab
        lastRunMetrics={{
          sessionId: "sess-1",
          modelName: "azure/run-model",
          modelConfig: { temperature: 0.7 },
          kbStats: [],
          toolStats: [],
        }}
        displayConfig={null}
      />,
    );

    expect(screen.getByText("run-model")).toBeInTheDocument();
    expect(screen.getByText("0.7")).toBeInTheDocument();
    // Top-p / Top-k / Token limit aren't in modelConfig and there's no
    // displayConfig fallback, so they render as em dashes rather than blank.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("[tag:agents] renders knowledge base, toolset, and model configuration", () => {
    renderWithProviders(
      <RunDetailsConfigurationTab
        lastRunMetrics={lastRunMetrics}
        displayConfig={displayConfig}
      />,
    );

    expect(screen.getByText("Product Docs")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("MCP Server")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("Executed")).toBeInTheDocument();
    expect(screen.getByText("42 ms")).toBeInTheDocument();
    expect(screen.getByText("Run Model")).toBeInTheDocument();
    expect(screen.getByText("0.2")).toBeInTheDocument();
    expect(screen.getByText("0.1")).toBeInTheDocument();
    expect(screen.getByText("3 chunks")).toBeInTheDocument();
    expect(screen.getByText("1500")).toBeInTheDocument();
  });

  it("[tag:agents] shows empty states when no knowledge bases or toolsets were used", () => {
    renderWithProviders(
      <RunDetailsConfigurationTab
        lastRunMetrics={{
          sessionId: "sess-1",
          traceId: "trace-1",
          kbStats: [],
          toolStats: [],
        }}
        displayConfig={displayConfig}
      />,
    );

    expect(screen.getByText("No knowledge bases were used in this run.")).toBeInTheDocument();
    expect(screen.getByText("No toolsets were used in this run.")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o Mini")).toBeInTheDocument();
    expect(screen.getByText("0.5")).toBeInTheDocument();
  });
});
