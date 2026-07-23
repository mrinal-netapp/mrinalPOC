import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, type RenderHookOptions } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";

import type {
  Agent,
  AgentAssociatedResources,
  KnowledgeBaseSummary,
} from "@/routes/pages/agents/api/agents-config.types";

// Mock the RTK Query hooks so we can drive the observable states of the
// panel without spinning up a real store. The hook reads the assigned KB
// refs from the agent query and resolves their detail columns from the KB
// list query, so both are mocked here.
const mockUseGetAgentQuery = vi.fn();
const mockUseListProjectKnowledgeBasesQuery = vi.fn();

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/routes/pages/agents/api/agents-config-api.slice",
  );
  return {
    ...actual,
    useGetAgentQuery: (...args: unknown[]) => mockUseGetAgentQuery(...args),
    useListProjectKnowledgeBasesQuery: (...args: unknown[]) =>
      mockUseListProjectKnowledgeBasesQuery(...args),
  };
});

import { useAgentAssignedKbs } from "./use-agent-assigned-kbs";

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

// Build a minimal `Agent` payload with just the fields the hook reads —
// the rest of the type is required at the API boundary, but we only
// care about `associatedResources.knowledgeBases` here. Cast through
// `unknown` so callers don't have to construct every persisted column.
function agentFixture(
  associatedResources?: AgentAssociatedResources,
): Agent {
  return { associatedResources } as unknown as Agent;
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

function setKbList(returnValue: {
  data?: KnowledgeBaseSummary[];
  isLoading?: boolean;
  isError?: boolean;
} = {}) {
  mockUseListProjectKnowledgeBasesQuery.mockReturnValue({
    data: returnValue.data,
    isLoading: returnValue.isLoading ?? false,
    isError: returnValue.isError ?? false,
  });
}

describe("useAgentAssignedKbs", () => {
  beforeEach(() => {
    mockUseGetAgentQuery.mockReset();
    mockUseListProjectKnowledgeBasesQuery.mockReset();
    // Default: KB list resolves empty so rows fall back to neutral defaults
    // unless a test opts into richer KB detail.
    setKbList({ data: [] });
  });

  it("[tag:agent-assigned-kb][tag:hook] returns empty rows when the endpoint returns no data", () => {
    setQuery({ data: undefined });
    const { result } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(result.current.rows).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it("[tag:agent-assigned-kb][tag:hook] returns empty rows when associatedResources is absent", () => {
    setQuery({ data: agentFixture(undefined) });
    const { result } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(result.current.rows).toEqual([]);
  });

  it("[tag:agent-assigned-kb][tag:hook] maps each associatedResources entry onto AssignedKnowledgeBaseRow", () => {
    setQuery({
      data: agentFixture({
        knowledgeBases: [
          { id: "kb-1", name: "Product docs" },
          { id: "kb-2", name: "Engineering wiki" },
        ],
        agentTeams: [],
      }),
    });
    const { result } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(result.current.rows).toEqual([
      {
        id: "kb-1",
        name: "Product docs",
        status: "Available",
        job: { state: "Ready", progress: 1 },
        indexed: { fileCount: 0, vectorCount: 0 },
        lastSyncISO: "",
        labels: [],
      },
      {
        id: "kb-2",
        name: "Engineering wiki",
        status: "Available",
        job: { state: "Ready", progress: 1 },
        indexed: { fileCount: 0, vectorCount: 0 },
        lastSyncISO: "",
        labels: [],
      },
    ]);
  });

  it("[tag:agent-assigned-kb][tag:hook] resolves status, job, indexed, last-sync and labels from the KB list", () => {
    setQuery({
      data: agentFixture({
        knowledgeBases: [
          { id: "kb-ready", name: "Product docs" },
          { id: "kb-busy", name: "Engineering wiki" },
          { id: "kb-bad", name: "Broken KB" },
        ],
        agentTeams: [],
      }),
    });
    setKbList({
      data: [
        {
          id: "kb-ready",
          name: "Product docs",
          status: "ready",
          labels: ["public"],
          lastSyncedAt: "2026-06-12T08:00:00Z",
          stats: { fileCount: 12, vectorCount: 3400 },
        },
        {
          id: "kb-busy",
          name: "Engineering wiki",
          status: "in_progress",
          progress: { phase: "embedding", percentage: 40 },
        },
        {
          id: "kb-bad",
          name: "Broken KB",
          status: "errored",
        },
      ],
    });

    const { result } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(result.current.rows).toEqual([
      {
        id: "kb-ready",
        name: "Product docs",
        status: "Available",
        job: { state: "Ready", progress: 1 },
        indexed: { fileCount: 12, vectorCount: 3400 },
        lastSyncISO: "2026-06-12T08:00:00Z",
        labels: ["public"],
      },
      {
        id: "kb-busy",
        name: "Engineering wiki",
        status: "Synchronizing",
        job: { state: "Processing", progress: 0.4 },
        indexed: { fileCount: 0, vectorCount: 0 },
        lastSyncISO: "",
        labels: [],
      },
      {
        id: "kb-bad",
        name: "Broken KB",
        status: "Errored",
        job: { state: "Processing", progress: 0 },
        indexed: { fileCount: 0, vectorCount: 0 },
        lastSyncISO: "",
        labels: [],
      },
    ]);
  });

  it("[tag:agent-assigned-kb][tag:hook] propagates isLoading + isError from either query", () => {
    setQuery({ isLoading: true });
    const { result: loading } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(loading.current.isLoading).toBe(true);

    setQuery({ isError: true });
    const { result: errored } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(errored.current.isError).toBe(true);

    setQuery({});
    setKbList({ isLoading: true });
    const { result: kbLoading } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(kbLoading.current.isLoading).toBe(true);

    setKbList({ isError: true });
    const { result: kbErrored } = renderHookWithProject(() => useAgentAssignedKbs("ag-1"));
    expect(kbErrored.current.isError).toBe(true);
  });

  it("[tag:agent-assigned-kb][tag:hook] skips the query for team agents (their detail page mounts a different panel set)", () => {
    setQuery({ data: undefined });
    renderHookWithProject(() => useAgentAssignedKbs("agr-mockt001"));
    expect(mockUseGetAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agr-mockt001" }),
      expect.objectContaining({ skip: true }),
    );
  });

  it("[tag:agent-assigned-kb][tag:hook] skips the query when the agent id is empty", () => {
    setQuery({ data: undefined });
    renderHookWithProject(() => useAgentAssignedKbs(""));
    expect(mockUseGetAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ id: "" }),
      expect.objectContaining({ skip: true }),
    );
  });

  it("[tag:agent-assigned-kb][tag:hook] returns a stable rows array across renders when the data is the same reference", () => {
    const payload = agentFixture({ knowledgeBases: [], agentTeams: [] });
    setQuery({ data: payload });
    const { result, rerender } = renderHookWithProject(
      ({ id }: { id: string }) => useAgentAssignedKbs(id),
      { initialProps: { id: "ag-1" } },
    );
    const first = result.current.rows;
    rerender({ id: "ag-1" });
    expect(result.current.rows).toBe(first);
  });
});
