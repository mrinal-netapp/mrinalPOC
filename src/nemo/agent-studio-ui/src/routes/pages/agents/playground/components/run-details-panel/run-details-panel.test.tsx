import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@test/render";
import { AGENTS_STRINGS, NEW_CONVERSATION_SESSION_ID } from "../../../agents.consts";
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

vi.mock("../run-details-execution-tab", () => ({
  RunDetailsExecutionTab: () => <div data-testid="run-details-execution-tab" />,
}));

vi.mock("../run-details-tracing-tab", () => ({
  RunDetailsTracingTab: () => <div data-testid="run-details-tracing-tab" />,
}));

vi.mock("../run-details-statistics-tab", () => ({
  RunDetailsStatisticsTab: () => <div data-testid="run-details-statistics-tab" />,
}));

vi.mock("../run-details-configuration-tab", () => ({
  RunDetailsConfigurationTab: () => <div data-testid="run-details-configuration-tab" />,
}));

const defaultProps = {
  agentId: "ag-test",
  selectedSessionId: NEW_CONVERSATION_SESSION_ID,
  onSessionChange: vi.fn(),
  isChatLoading: false,
  lastRunMetrics: null,
  liveExecutionSteps: [],
  displayConfig: null,
  pendingSessionIds: [] as string[],
};

describe("RunDetailsPanel", () => {
  it("[tag:agents] renders output details header and execution tab by default", () => {
    mockUseListAgentSessionsQuery.mockReturnValue({ data: { sessions: [] } });
    mockUseGetAgentSessionQuery.mockReturnValue({ data: undefined });
    mockUseGetTraceSpansQuery.mockReturnValue({ data: undefined });

    renderWithProviders(<RunDetailsPanel {...defaultProps} />);

    expect(screen.getByText(AGENTS_STRINGS.OUTPUT_DETAILS_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId("run-details-execution-tab")).toBeInTheDocument();
  });

  it("[tag:agents] switches to statistics tab", async () => {
    mockUseListAgentSessionsQuery.mockReturnValue({
      data: {
        sessions: [{ sessionId: "session-1", name: "Run 1" }],
      },
    });
    mockUseGetAgentSessionQuery.mockReturnValue({ data: undefined });
    mockUseGetTraceSpansQuery.mockReturnValue({ data: [] });

    const user = userEvent.setup();
    renderWithProviders(
      <RunDetailsPanel
        {...defaultProps}
        selectedSessionId="session-1"
        lastRunMetrics={{
          sessionId: "session-1",
          traceId: "trace-1",
          latencyMs: 100,
        }}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Statistics" }));
    expect(screen.getByTestId("run-details-statistics-tab")).toBeInTheDocument();
  });

  it("[tag:agents] switches to tracing and configuration tabs and merges pending sessions", async () => {
    mockUseListAgentSessionsQuery.mockReturnValue({
      data: { sessions: [{ sessionId: "session-1", name: "Run 1" }] },
    });
    mockUseGetAgentSessionQuery.mockReturnValue({
      data: {
        sessionId: "session-2",
        name: "Active session",
        createdAt: "2026-01-01T00:00:00Z",
        messages: [{ role: "assistant", content: "Done", traceId: "trace-2" }],
      },
    });
    mockUseGetTraceSpansQuery.mockReturnValue({ data: [] });

    const user = userEvent.setup();
    renderWithProviders(
      <RunDetailsPanel
        {...defaultProps}
        selectedSessionId="session-2"
        pendingSessionIds={["session-pending"]}
        lastRunMetrics={{
          sessionId: "session-2",
          traceId: "trace-2",
          latencyMs: 100,
        }}
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

    await user.click(screen.getByRole("tab", { name: "Tracing" }));
    expect(screen.getByTestId("run-details-tracing-tab")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(screen.getByTestId("run-details-configuration-tab")).toBeInTheDocument();
  });

  it("[tag:agents] uses live execution steps while chat is loading", () => {
    mockUseListAgentSessionsQuery.mockReturnValue({ data: { sessions: [] } });
    mockUseGetAgentSessionQuery.mockReturnValue({ data: undefined });
    mockUseGetTraceSpansQuery.mockReturnValue({ data: undefined });

    renderWithProviders(
      <RunDetailsPanel
        {...defaultProps}
        isChatLoading
        liveExecutionSteps={[
          {
            toolCallId: "call-live",
            toolName: "search",
            status: "running",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("run-details-execution-tab")).toBeInTheDocument();
  });

  it("[tag:agents] disables run selector without agent id and uses session detail metrics", () => {
    mockUseListAgentSessionsQuery.mockReturnValue({ data: { sessions: [] } });
    mockUseGetAgentSessionQuery.mockReturnValue({
      data: {
        sessionId: "session-detail",
        name: "Historical run",
        createdAt: "2026-01-01T00:00:00Z",
        messages: [
          { role: "assistant", content: "Answer", traceId: "trace-detail", latencyMs: 44 },
        ],
      },
    });
    mockUseGetTraceSpansQuery.mockReturnValue({ data: [] });

    renderWithProviders(
      <RunDetailsPanel
        {...defaultProps}
        agentId={null}
        selectedSessionId="session-detail"
        lastRunMetrics={{
          sessionId: "other-session",
          traceId: "trace-other",
          latencyMs: 10,
        }}
      />,
    );

    expect(document.querySelector(".select-dropdown-wrapper--disabled")).toBeInTheDocument();
  });
});
