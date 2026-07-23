import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/utils/unit-tests";
import { RunDetailsExecutionTab } from "./run-details-execution-tab";

describe("RunDetailsExecutionTab", () => {
  it("[tag:agents] shows empty message when no execution steps exist", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[]}
        isLoading={false}
        emptyMessage="No tool calls were captured for this run."
      />,
    );

    expect(screen.getByText("No tool calls were captured for this run.")).toBeInTheDocument();
  });

  it("[tag:agents] shows loading state while awaiting the first execution step", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[]}
        isLoading
        emptyMessage="No tool calls were captured for this run."
      />,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(document.querySelector(".run-details-execution__loading")).toBeInTheDocument();
    expect(screen.queryByText("No tool calls were captured for this run.")).not.toBeInTheDocument();
  });

  it("[tag:agents] expands running steps and collapses completed steps by default", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "completed-step",
            toolName: "get_metrics",
            status: "completed",
            elapsedMs: 95,
            result: { ok: true },
          },
          {
            toolCallId: "running-step",
            toolName: "search_knowledge_base",
            displayName: "Knowledge base retrieval",
            status: "running",
            kbRetrievalDetails: {
              query: "LIBERTY MAGNIFICENT movie",
              chunks: [],
            },
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    expect(screen.getByText("LIBERTY MAGNIFICENT movie")).toBeInTheDocument();
    expect(screen.queryByText(/"ok": true/)).not.toBeInTheDocument();
  });

  it("[tag:agents] renders knowledge base retrieval layout from mapped payload", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "tool-call-kb",
            toolName: "search_knowledge_base",
            displayName: "Knowledge base retrieval",
            status: "completed",
            elapsedMs: 95,
            kbRetrievalDetails: {
              knowledgeBaseId: "kba64shx73",
              topKLabel: "10 chunks",
              totalContextLabel: "711 tokens",
              query: "LIBERTY MAGNIFICENT movie",
              chunks: [
                {
                  fileLabel: "LIBERTY MAGNIFICENT",
                  path: "proj7l50k5do.azure-mysql",
                  scoreLabel: "100%",
                  tokensLabel: "42 tokens",
                },
                {
                  fileLabel: "CARIBBEAN LIBERTY",
                  path: "proj7l50k5do.azure-mysql",
                  scoreLabel: "97%",
                  tokensLabel: "38 tokens",
                },
              ],
            },
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Knowledge base retrieval/i }));

    expect(screen.getByText("Step 1: Knowledge base retrieval")).toBeInTheDocument();
    expect(screen.getByText(/Completed · 95 ms/)).toBeInTheDocument();
    expect(screen.getByText("Retrieval details")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /kba64shx73/i })).toHaveAttribute(
      "href",
      "/knowledge-bases/kba64shx73",
    );
    expect(screen.getByText("Top K")).toBeInTheDocument();
    expect(screen.getByText("10 chunks")).toBeInTheDocument();
    expect(screen.getByText("Total retrieved context")).toBeInTheDocument();
    expect(screen.getByText("711 tokens")).toBeInTheDocument();
    expect(screen.getByText("LIBERTY MAGNIFICENT movie")).toBeInTheDocument();
    expect(screen.getByText("LIBERTY MAGNIFICENT")).toBeInTheDocument();
    expect(screen.getByText("CARIBBEAN LIBERTY")).toBeInTheDocument();
    expect(screen.getAllByText("proj7l50k5do.azure-mysql").length).toBeGreaterThan(0);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
  });

  it("[tag:agents] shows knowledge base retrieval title and spinner while running", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "tool-call-kb",
            toolName: "search_knowledge_base",
            status: "running",
            kbRetrievalDetails: {
              query: "LIBERTY MAGNIFICENT movie",
              chunks: [],
            },
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    expect(screen.getByText("Step 1: Knowledge base retrieval")).toBeInTheDocument();
    expect(screen.getByText("LIBERTY MAGNIFICENT movie")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(document.querySelector(".run-details-execution__step-spinner")).toBeInTheDocument();
  });

  it("[tag:agents] copies knowledge base logs to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "tool-call-kb",
            toolName: "search_knowledge_base",
            status: "completed",
            kbRetrievalDetails: {
              knowledgeBaseId: "kba64shx73",
              query: "test",
              chunks: [],
              logs: ["[95ms] INFO Retrieval complete"],
            },
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Knowledge base retrieval/i }));
    fireEvent.click(screen.getByRole("button", { name: "Copy logs" }));

    expect(writeText).toHaveBeenCalledWith("[95ms] INFO Retrieval complete");
  });

  it("[tag:agents] renders generic tool args/results and toggles completed steps", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "generic-step",
            toolName: "get_metrics",
            displayName: "Metrics lookup",
            status: "completed",
            elapsedMs: undefined,
            args: { volume: "vol-1" },
            result: undefined,
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Metrics lookup/i }));
    expect(screen.getByText(/"volume": "vol-1"/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /Metrics lookup/i }));
    expect(screen.queryByText(/"volume": "vol-1"/)).not.toBeInTheDocument();
  });

  it("[tag:agents] collapses running steps and truncates long kb logs", () => {
    const longLogs = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`);
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "running-kb",
            toolName: "search_knowledge_base",
            status: "running",
            elapsedMs: 12,
            kbRetrievalDetails: {
              query: "query",
              chunks: [],
              logs: longLogs,
            },
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    expect(screen.queryByText((content) => content.includes("line-8"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show more/i }));
    expect(screen.getByText((content) => content.includes("line-8"))).toBeInTheDocument();
  });

  it("[tag:agents] renders failed step label with elapsed time", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "failed-step",
            toolName: "get_metrics",
            displayName: "Metrics lookup",
            status: "failed",
            elapsedMs: 42,
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    expect(screen.getByText(/Failed · 42 ms/)).toBeInTheDocument();
  });

  it("[tag:agents] shows kb unknown labels when retrieval metadata is missing", () => {
    renderWithProviders(
      <RunDetailsExecutionTab
        steps={[
          {
            toolCallId: "kb-empty",
            toolName: "search_knowledge_base",
            status: "completed",
            kbRetrievalDetails: {
              chunks: [],
            },
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Knowledge base retrieval/i }));
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("No retrieved chunks.")).toBeInTheDocument();
  });
});
