import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@test/render";
import { RunDetailsPanel } from "./run-details-panel";

const mockUseListAgentSessionsQuery = vi.fn();
const mockUseGetAgentSessionQuery = vi.fn();
const mockUseGetTraceSpansQuery = vi.fn();

vi.mock("../../../api/agents-runtime-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api/agents-runtime-api.slice")>();
  return {
    ...actual,
    useListAgentSessionsQuery: (...args: unknown[]) => mockUseListAgentSessionsQuery(...args),
    useGetAgentSessionQuery: (...args: unknown[]) => mockUseGetAgentSessionQuery(...args),
    useGetTraceSpansQuery: (...args: unknown[]) => mockUseGetTraceSpansQuery(...args),
  };
});

vi.mock("@/api/api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/api.slice")>();
  return {
    ...actual,
    shouldSkipQuery: () => false,
  };
});

describe("RunDetailsPanel integration", () => {
  it("[tag:agents] renders real tab content from session metrics and trace spans", async () => {
    mockUseListAgentSessionsQuery.mockReturnValue({
      data: { sessions: [{ sessionId: "session-1", name: "Run 1" }] },
    });
    mockUseGetAgentSessionQuery.mockReturnValue({ data: undefined });
    mockUseGetTraceSpansQuery.mockReturnValue({
      data: [
        {
          id: "trace-step",
          name: "Agent.arun",
          context: { span_id: "trace-step" },
          span_kind: "AGENT",
          start_time: "2026-05-19T10:00:00.000Z",
          end_time: "2026-05-19T10:00:01.000Z",
          attributes: { "input.value": "hello", "output.value": "world" },
        },
      ],
    });

    const onSessionChange = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <RunDetailsPanel
        agentId="ag-test"
        selectedSessionId="session-1"
        onSessionChange={onSessionChange}
        isChatLoading={false}
        lastRunMetrics={{
          sessionId: "session-1",
          traceId: "trace-1",
          latencyMs: 120,
          usage: { totalTokens: 42, promptTokens: 30, completionTokens: 12 },
          toolStats: [
            {
              toolName: "search",
              serverName: "server",
              serverId: "srv-1",
              status: "executed",
              latencyMs: 10,
            },
          ],
        }}
        liveExecutionSteps={[
          {
            toolCallId: "call-1",
            toolName: "get_metrics",
            status: "completed",
            elapsedMs: 10,
            result: { ok: true },
          },
        ]}
        displayConfig={{
          agentId: "ag-test",
          agentName: "Agent",
          mode: "single-turn",
          instructions: "",
          temperature: 0.5,
          topP: 0.3,
          topKChunks: 4,
          tokenLimit: 1000,
          modelDisplayName: "GPT-4o",
        }}
      />,
    );

    expect(screen.getByText(/Completed · 10 ms/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tracing" }));
    expect(screen.getByText(/Agent\.arun/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Statistics" }));
    expect(screen.getByText("Total tokens")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(screen.getByText("Model name")).toBeInTheDocument();
  });
});
