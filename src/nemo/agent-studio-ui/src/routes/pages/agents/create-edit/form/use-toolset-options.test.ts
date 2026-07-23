import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";
import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types";

const TEST_PROJECT_ID = "test-project";

const mockUseListMcpServersQuery = vi.fn();

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListMcpServersQuery: (...args: unknown[]) =>
    mockUseListMcpServersQuery(...args),
}));

import { useToolsetOptions } from "./use-toolset-options";

function renderHookWithProject<T>(callback: () => T) {
  const store = createMockStore({
    projectContext: {
      activeProject: { id: TEST_PROJECT_ID, name: "", role: "admin" },
    },
  });
  return renderHook(callback, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children }),
  });
}

function setQuery(value: {
  data?: McpServerSummary[];
  isLoading?: boolean;
  isError?: boolean;
}) {
  mockUseListMcpServersQuery.mockReturnValue({
    data: value.data,
    isLoading: value.isLoading ?? false,
    isError: value.isError ?? false,
  });
}

describe("useToolsetOptions", () => {
  beforeEach(() => mockUseListMcpServersQuery.mockReset());

  it("[tag:toolset-options][tag:hook] maps MCP servers to toolset options with health + allowlist tools", () => {
    setQuery({
      data: [
        {
          id: "m1",
          name: "GitHub",
          description: "gh",
          status: "connected",
          allowedTools: ["search", "create"],
          labels: ["prod"],
        },
        { id: "m2", name: "Calc", status: "error" },
      ] as McpServerSummary[],
    });
    const { result } = renderHookWithProject(() => useToolsetOptions());
    expect(result.current.options).toEqual([
      {
        id: "m1",
        name: "GitHub",
        description: "gh",
        status: "healthy",
        labels: ["prod"],
        tools: [
          { id: "search", name: "search", description: "" },
          { id: "create", name: "create", description: "" },
        ],
        allowedToolNames: ["search", "create"],
      },
      {
        id: "m2",
        name: "Calc",
        description: undefined,
        status: "unhealthy",
        labels: [],
        tools: [],
        allowedToolNames: undefined,
      },
    ]);
  });

  it("[tag:toolset-options][tag:hook] normalizes a null allow-list to undefined (no restriction)", () => {
    // config-service returns `allowedTools: null` for a server with no
    // allow-list; the picker must treat that as "allow all", so the mapped
    // option carries `allowedToolNames: undefined` (never a raw null that a
    // downstream `.includes(...)` would throw on).
    setQuery({
      data: [
        {
          id: "m1",
          name: "Analytics",
          status: "connected",
          allowedTools: null,
        },
      ] as McpServerSummary[],
    });
    const { result } = renderHookWithProject(() => useToolsetOptions());
    expect(result.current.options[0].allowedToolNames).toBeUndefined();
    expect(result.current.options[0].tools).toEqual([]);
  });

  it("[tag:toolset-options][tag:hook] maps disconnected->degraded and unknown->unknown", () => {
    setQuery({
      data: [
        { id: "a", name: "A", status: "disconnected" },
        { id: "b", name: "B", status: "unknown" },
      ] as McpServerSummary[],
    });
    const { result } = renderHookWithProject(() => useToolsetOptions());
    expect(result.current.options.map((o) => o.status)).toEqual([
      "degraded",
      "unknown",
    ]);
  });

  it("[tag:toolset-options][tag:hook] returns empty options when there is no data", () => {
    setQuery({ data: undefined });
    const { result } = renderHookWithProject(() => useToolsetOptions());
    expect(result.current.options).toEqual([]);
  });

  it("[tag:toolset-options][tag:hook] propagates loading and error", () => {
    setQuery({ isLoading: true });
    expect(renderHookWithProject(() => useToolsetOptions()).result.current.isLoading).toBe(
      true,
    );
    setQuery({ isError: true });
    expect(renderHookWithProject(() => useToolsetOptions()).result.current.isError).toBe(
      true,
    );
  });

  it("[tag:toolset-options][tag:hook] queries with the project id and an enabled (non-skipped) flag", () => {
    setQuery({ data: [] });
    renderHookWithProject(() => useToolsetOptions());
    expect(mockUseListMcpServersQuery).toHaveBeenCalledWith(
      { projectId: TEST_PROJECT_ID },
      { skip: false },
    );
  });
});
