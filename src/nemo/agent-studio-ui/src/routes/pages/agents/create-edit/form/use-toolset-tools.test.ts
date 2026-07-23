import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";
import type { McpServerTool } from "@/routes/pages/agents/api/agents-config.types";

const TEST_PROJECT_ID = "test-project";

const mockUseListMcpServerToolsQuery = vi.fn();

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListMcpServerToolsQuery: (...args: unknown[]) =>
    mockUseListMcpServerToolsQuery(...args),
}));

import { useToolsetTools } from "./use-toolset-tools";

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
  data?: McpServerTool[];
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  isSuccess?: boolean;
}) {
  mockUseListMcpServerToolsQuery.mockReturnValue({
    data: value.data,
    isLoading: value.isLoading ?? false,
    isFetching: value.isFetching ?? false,
    isError: value.isError ?? false,
    isSuccess: value.isSuccess ?? false,
  });
}

describe("useToolsetTools", () => {
  beforeEach(() => mockUseListMcpServerToolsQuery.mockReset());

  it("[tag:toolset-tools][tag:hook] maps the live tool catalog with descriptions", () => {
    setQuery({
      data: [
        { name: "search", description: "Search repos" },
        { name: "create" },
      ] as McpServerTool[],
      isSuccess: true,
    });
    const { result } = renderHookWithProject(() => useToolsetTools("m1"));
    expect(result.current.tools).toEqual([
      { id: "search", name: "search", description: "Search repos" },
      { id: "create", name: "create", description: "" },
    ]);
    expect(result.current.isReady).toBe(true);
  });

  it("[tag:toolset-tools][tag:hook] skips the query (and reports not-loading/ready) when no toolset is selected", () => {
    setQuery({ isLoading: true, isError: true, isSuccess: true });
    const { result } = renderHookWithProject(() => useToolsetTools(""));
    expect(mockUseListMcpServerToolsQuery).toHaveBeenCalledWith(
      { projectId: TEST_PROJECT_ID, id: "" },
      { skip: true },
    );
    // While skipped, the upstream flags are suppressed.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.isReady).toBe(false);
  });

  it("[tag:toolset-tools][tag:hook] reports loading while fetching for a selected toolset", () => {
    setQuery({ isFetching: true });
    const { result } = renderHookWithProject(() => useToolsetTools("m1"));
    expect(result.current.isLoading).toBe(true);
  });

  it("[tag:toolset-tools][tag:hook] surfaces errors for a selected toolset", () => {
    setQuery({ isError: true });
    const { result } = renderHookWithProject(() => useToolsetTools("m1"));
    expect(result.current.isError).toBe(true);
  });
});
