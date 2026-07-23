import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, type RenderHookOptions } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";

import type { KnowledgeBaseSummary } from "@/routes/pages/agents/api/agents-config.types";
import { setActiveProject } from "@/store/slices/project-context.slice";

const TEST_PROJECT_ID = "test-project";

const mockUseListProjectKnowledgeBasesQuery = vi.fn();

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListProjectKnowledgeBasesQuery: (...args: unknown[]) =>
    mockUseListProjectKnowledgeBasesQuery(...args),
}));

import { useKnowledgeBaseOptions } from "./use-knowledge-base-options";

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

function setQuery(value: {
  data?: KnowledgeBaseSummary[];
  isLoading?: boolean;
  isError?: boolean;
}) {
  mockUseListProjectKnowledgeBasesQuery.mockReturnValue({
    data: value.data,
    isLoading: value.isLoading ?? false,
    isError: value.isError ?? false,
  });
}

describe("useKnowledgeBaseOptions", () => {
  beforeEach(() => mockUseListProjectKnowledgeBasesQuery.mockReset());

  it("[tag:kb-options][tag:hook] maps KBs to options without a versions field", () => {
    setQuery({
      data: [
        { id: "kb1", name: "Docs", status: "ready", labels: ["prod"] },
      ] as KnowledgeBaseSummary[],
    });
    const { result } = renderHookWithProject(() => useKnowledgeBaseOptions());
    expect(result.current.options).toEqual([
      {
        id: "kb1",
        name: "Docs",
        status: "available",
        labels: ["prod"],
      },
    ]);
    expect(result.current.options[0]).not.toHaveProperty("versions");
    expect(mockUseListProjectKnowledgeBasesQuery).toHaveBeenCalledWith(
      { projectId: TEST_PROJECT_ID },
      { skip: false },
    );
  });

  it("[tag:kb-options][tag:hook] maps the status vocabulary onto the dialog palette", () => {
    setQuery({
      data: [
        { id: "a", name: "A", status: "ready" },
        { id: "b", name: "B", status: "in_progress" },
        { id: "c", name: "C", status: "errored" },
        { id: "u", name: "Unknown", status: "queued" as KnowledgeBaseSummary["status"] },
      ] as KnowledgeBaseSummary[],
    });
    const { result } = renderHookWithProject(() => useKnowledgeBaseOptions());
    expect(result.current.options.map((o) => o.status)).toEqual([
      "available",
      "indexing",
      "unavailable",
      "unknown",
    ]);
  });

  it("[tag:kb-options][tag:hook] excludes deprecated KBs (cannot be newly assigned)", () => {
    setQuery({
      data: [
        { id: "a", name: "A", status: "ready" },
        { id: "d", name: "D", status: "deprecated" },
      ] as KnowledgeBaseSummary[],
    });
    const { result } = renderHookWithProject(() => useKnowledgeBaseOptions());
    expect(result.current.options.map((o) => o.id)).toEqual(["a"]);
  });

  it("[tag:kb-options][tag:hook] defaults labels and returns empty options when there is no data", () => {
    setQuery({ data: [{ id: "a", name: "A", status: "ready" }] as KnowledgeBaseSummary[] });
    expect(
      renderHookWithProject(() => useKnowledgeBaseOptions()).result.current.options[0]?.labels,
    ).toEqual([]);

    setQuery({ data: undefined });
    expect(
      renderHookWithProject(() => useKnowledgeBaseOptions()).result.current.options,
    ).toEqual([]);
  });

  it("[tag:kb-options][tag:hook] propagates loading and error", () => {
    setQuery({ isLoading: true });
    expect(
      renderHookWithProject(() => useKnowledgeBaseOptions()).result.current.isLoading,
    ).toBe(true);
    setQuery({ isError: true });
    expect(
      renderHookWithProject(() => useKnowledgeBaseOptions()).result.current.isError,
    ).toBe(true);
  });

  it("[tag:kb-options][tag:hook] skips the query when no active project is selected", () => {
    setQuery({ data: [] });
    const store = createMockStore({
      projectContext: { activeProject: { id: "", name: "", role: null } },
    });
    store.dispatch(setActiveProject({ id: "", name: "" }));
    renderHook(() => useKnowledgeBaseOptions(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(Provider, { store, children }),
    });
    expect(mockUseListProjectKnowledgeBasesQuery).toHaveBeenCalledWith(
      { projectId: "" },
      { skip: true },
    );
  });
});
