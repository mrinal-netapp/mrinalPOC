import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/utils/unit-tests";
import { RunDetailsTracingTab } from "./run-details-tracing-tab";

describe("RunDetailsTracingTab", () => {
  it("[tag:agents] shows loading state while awaiting the first tracing step", () => {
    renderWithProviders(
      <RunDetailsTracingTab
        steps={[]}
        isLoading
        emptyMessage="No trace spans were captured for this run."
      />,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No trace spans were captured for this run.")).not.toBeInTheDocument();
  });

  it("[tag:agents] shows empty message when no tracing steps exist", () => {
    renderWithProviders(
      <RunDetailsTracingTab steps={[]} isLoading={false} emptyMessage="No trace spans were captured." />,
    );

    expect(screen.getByText("No trace spans were captured.")).toBeInTheDocument();
  });

  it("[tag:agents] keeps trace steps collapsed by default", () => {
    renderWithProviders(
      <RunDetailsTracingTab
        steps={[
          {
            id: "agent-step",
            name: "Agent.arun",
            spanKind: "AGENT",
            durationMs: 7500,
            input: "hello",
            output: "world",
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    expect(screen.getByText("Step 1: Agent.arun")).toBeInTheDocument();
    expect(screen.getByText(/Completed · 7500 ms/)).toBeInTheDocument();
    expect(screen.queryByText("Span Kind")).not.toBeInTheDocument();
    expect(screen.queryByText("hello")).not.toBeInTheDocument();
  });

  it("[tag:agents] expands a trace step to show span kind and io values", () => {
    renderWithProviders(
      <RunDetailsTracingTab
        steps={[
          {
            id: "llm-step",
            name: "LiteLLM.ainvoke_stream",
            spanKind: "LLM",
            durationMs: 120,
            input: '{\n  "prompt": "test"\n}',
            output: '{\n  "answer": "ok"\n}',
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /LiteLLM\.ainvoke_stream/i }));

    expect(screen.getByText("Span Kind")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText(/"prompt": "test"/)).toBeInTheDocument();
    expect(screen.getByText(/"answer": "ok"/)).toBeInTheDocument();
  });

  it("[tag:agents] copies trace output to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderWithProviders(
      <RunDetailsTracingTab
        steps={[
          {
            id: "tool-step",
            name: "search_knowledge_base",
            spanKind: "TOOL",
            durationMs: 95,
            input: null,
            output: "retrieved chunks",
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search_knowledge_base/i }));
    fireEvent.click(screen.getByRole("button", { name: "Copy output" }));

    expect(writeText).toHaveBeenCalledWith("retrieved chunks");
  });

  it("[tag:agents] truncates long trace values and collapses expanded steps", () => {
    const longValue = Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\n");
    renderWithProviders(
      <RunDetailsTracingTab
        steps={[
          {
            id: "tool-step",
            name: "search_knowledge_base",
            spanKind: "TOOL",
            durationMs: null,
            input: longValue,
            output: null,
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /search_knowledge_base/i }));
    expect(screen.queryByText("line-8")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show more/i }));
    expect(screen.getByText((content) => content.includes("line-8"))).toBeInTheDocument();
    fireEvent.click(document.querySelector(".run-details-tracing__collapse-step") as HTMLButtonElement);
    expect(screen.queryByText("Span Kind")).not.toBeInTheDocument();
  });

  it("[tag:agents] skips copy when trace input is empty", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderWithProviders(
      <RunDetailsTracingTab
        steps={[
          {
            id: "empty-step",
            name: "Agent.arun",
            spanKind: "AGENT",
            durationMs: 10,
            input: null,
            output: null,
          },
        ]}
        isLoading={false}
        emptyMessage="No steps"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Agent\.arun/i }));
    expect(screen.queryByRole("button", { name: "Copy input" })).not.toBeInTheDocument();
  });
});
