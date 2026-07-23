import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, type RenderHookOptions } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";

import type { Agent } from "@/routes/pages/agents/api/agents-config.types";

// Mock the RTK Query hook so we can drive the four observable states
// of the panel (loading / error / empty / populated) without spinning
// up a real store. The shape of the mock matches what the wired hook
// returns at the boundaries we actually consume.
const mockUseGetAgentQuery = vi.fn();
const mockUseListMcpServersQuery = vi.fn();

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/routes/pages/agents/api/agents-config-api.slice",
  );
  return {
    ...actual,
    useGetAgentQuery: (...args: unknown[]) => mockUseGetAgentQuery(...args),
    useListMcpServersQuery: (...args: unknown[]) =>
      mockUseListMcpServersQuery(...args),
  };
});

import { useAgentToolsets } from "./use-agent-toolsets";

const TEST_PROJECT_ID = "test-project";

function renderHookWithProject<TProps, TResult>(
  callback: (props: TProps) => TResult,
  options?: RenderHookOptions<TProps>,
) {
  const store = createMockStore({
    projectContext: {
      activeProject: { id: TEST_PROJECT_ID, name: "", role: null },
    },
  });
  return renderHook(callback, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children }),
  });
}

// Build a minimal `Agent` payload with just the fields the toolsets hook
// reads — the rest of the type is required at the API boundary. Cast through
// `unknown` so
// callers don't have to construct every persisted column.
function agentFixture(
  mcpServerIds?: Agent["mcpServerIds"],
): Agent {
  return { mcpServerIds } as unknown as Agent;
}

function setQuery(returnValue: {
  data?: Agent;
  isLoading?: boolean;
  isError?: boolean;
}) {
  mockUseGetAgentQuery.mockReturnValue({
    data: returnValue.data,
    isLoading: returnValue.isLoading ?? false,
    isError: returnValue.isError ?? false,
  });
}

function setMcpList(data?: unknown[]) {
  mockUseListMcpServersQuery.mockReturnValue({
    data,
    isLoading: false,
    isError: false,
  });
}

describe("useAgentToolsets", () => {
  beforeEach(() => {
    mockUseGetAgentQuery.mockReset();
    mockUseListMcpServersQuery.mockReset();
    // Default: no MCP server detail unless a test opts in.
    setMcpList([]);
  });

  it("[tag:agent-toolsets][tag:hook] returns empty rows when the endpoint returns no data", () => {
    setQuery({ data: undefined });
    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(result.current.rows).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("[tag:agent-toolsets][tag:hook] returns empty rows when mcpServerIds is absent", () => {
    setQuery({ data: agentFixture(undefined) });
    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(result.current.rows).toEqual([]);
  });

  it("[tag:agent-toolsets][tag:hook] maps each selected mcpServerId onto ToolsetRow", () => {
    setQuery({
      data: agentFixture(["mcp-1", "mcp-2"]),
    });
    setMcpList([
      { id: "mcp-1", name: "GitHub", status: "connected", deploymentType: "remote", labels: [] },
      { id: "mcp-2", name: "Calculator", status: "connected", deploymentType: "managed", labels: [] },
    ]);
    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(result.current.rows).toEqual([
      {
        id: "mcp-1",
        name: "GitHub",
        type: "Remote",
        status: "Healthy",
        associatedAgents: [],
        labels: [],
      },
      {
        id: "mcp-2",
        name: "Calculator",
        type: "Local",
        status: "Healthy",
        associatedAgents: [],
        labels: [],
      },
    ]);
  });

  it("[tag:agent-toolsets][tag:hook] maps the backend connection status onto toolset health", () => {
    setQuery({
      data: agentFixture([
        "mcp-connected",
        "mcp-disconnected",
        "mcp-error",
        "mcp-unknown",
        "mcp-missing",
      ]),
    });
    setMcpList([
      { id: "mcp-connected", name: "Connected", status: "connected", labels: [] },
      { id: "mcp-disconnected", name: "Disconnected", status: "disconnected", labels: [] },
      { id: "mcp-error", name: "Errored", status: "error", labels: [] },
      { id: "mcp-unknown", name: "Unknown", status: "unknown", labels: [] },
      // mcp-missing intentionally absent.
    ]);
    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    const statusById = Object.fromEntries(
      result.current.rows.map((row) => [row.id, row.status]),
    );
    expect(statusById).toEqual({
      "mcp-connected": "Healthy",
      "mcp-disconnected": "Unhealthy",
      "mcp-error": "Unhealthy",
      "mcp-unknown": "Unhealthy",
      "mcp-missing": "Unhealthy",
    });
  });

  it("[tag:agent-toolsets][tag:hook] joins labels from the MCP servers endpoint by id", () => {
    setQuery({
      data: agentFixture(["mcp-1", "mcp-2"]),
    });
    setMcpList([
      { id: "mcp-1", name: "GitHub", status: "connected", labels: ["vcs", "prod"] },
      // mcp-2 intentionally absent → labels fall back to [].
    ]);

    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    const labelsById = Object.fromEntries(
      result.current.rows.map((row) => [row.id, row.labels]),
    );
    expect(labelsById).toEqual({
      "mcp-1": ["vcs", "prod"],
      "mcp-2": [],
    });
  });

  it("[tag:agent-toolsets][tag:hook] falls back to the server id when list details are unavailable", () => {
    setQuery({
      data: agentFixture(["mcp-no-name"]),
    });
    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(result.current.rows[0]?.name).toBe("mcp-no-name");
  });

  it("[tag:agent-toolsets][tag:hook] ignores _resolvedMCPServers when mcpServerIds is empty", () => {
    setQuery({
      data: {
        mcpServerIds: [],
        _resolvedMCPServers: {
          "mcp-default": { name: "Default MCP", status: "connected", catalogId: "default" },
        },
      } as unknown as Agent,
    });
    setMcpList([
      { id: "mcp-default", name: "Default MCP", status: "connected", labels: [] },
    ]);
    const { result } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(result.current.rows).toEqual([]);
  });

  it("[tag:agent-toolsets][tag:hook] propagates isLoading + isError from the RTK Query result", () => {
    setQuery({ isLoading: true });
    const { result: loading } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(loading.current.isLoading).toBe(true);

    setQuery({ isError: true });
    const { result: errored } = renderHookWithProject(() => useAgentToolsets("ag-1"));
    expect(errored.current.isError).toBe(true);
  });

  it("[tag:agent-toolsets][tag:hook] skips the query for team agents (their detail page mounts a different panel set)", () => {
    setQuery({ data: undefined });
    renderHookWithProject(() => useAgentToolsets("agr-mockt001"));
    expect(mockUseGetAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agr-mockt001" }),
      expect.objectContaining({ skip: true }),
    );
  });

  it("[tag:agent-toolsets][tag:hook] skips the query when the agent id is empty", () => {
    setQuery({ data: undefined });
    renderHookWithProject(() => useAgentToolsets(""));
    expect(mockUseGetAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "" }),
      expect.objectContaining({ skip: true }),
    );
  });

  it("[tag:agent-toolsets][tag:hook] returns a stable rows array across renders when the data is the same reference", () => {
    const payload = agentFixture([]);
    setQuery({ data: payload });
    const { result, rerender } = renderHookWithProject(
      ({ id }: { id: string }) => useAgentToolsets(id),
      { initialProps: { id: "ag-1" } },
    );
    const first = result.current.rows;
    rerender({ id: "ag-1" });
    expect(result.current.rows).toBe(first);
  });
});
