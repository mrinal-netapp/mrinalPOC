import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, type RenderHookOptions } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";

import type { Agent, AgentTeam } from "@/routes/pages/agents/api/agents-config.types";

const TEST_PROJECT_ID = "test-project";

const mockUseListAgentsQuery = vi.fn();
const mockUseListAgentTeamsQuery = vi.fn();

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListAgentsQuery: (...args: unknown[]) => mockUseListAgentsQuery(...args),
  useListAgentTeamsQuery: (...args: unknown[]) =>
    mockUseListAgentTeamsQuery(...args),
}));

import {
  useTeamAgentOptions,
  useTeamTeamOptions,
} from "./use-team-member-options";

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

beforeEach(() => {
  mockUseListAgentsQuery.mockReset();
  mockUseListAgentTeamsQuery.mockReset();
});

describe("useTeamAgentOptions", () => {
  it("[tag:team-options][tag:hook] maps agents to sub-entities and id-keyed items", () => {
    mockUseListAgentsQuery.mockReturnValue({
      data: [
        {
          id: "ag1",
          name: "Planner",
          status: "Healthy",
          deploymentStatus: "deployed",
          labels: ["core"],
        },
        {
          id: "ag2",
          name: "Worker",
          status: "Unhealthy",
          deploymentStatus: "not_deployed",
        },
      ] as unknown as Agent[],
      isLoading: false,
      isError: false,
    });

    const { result } = renderHookWithProject(() => useTeamAgentOptions());
    expect(result.current.entities).toEqual([
      {
        id: "ag1",
        name: "Planner",
        status: "healthy",
        deployment: "Deployed",
        labels: ["core"],
      },
      {
        id: "ag2",
        name: "Worker",
        status: "unhealthy",
        deployment: "Not deployed",
        labels: [],
      },
    ]);
    expect(result.current.items).toEqual([
      { key: "ag1", value: "ag1", label: "Planner" },
      { key: "ag2", value: "ag2", label: "Worker" },
    ]);
    expect(mockUseListAgentsQuery).toHaveBeenCalledWith(
      { projectId: TEST_PROJECT_ID, limit: 500, include: "dependentsSummary=false" },
      { skip: false },
    );
  });

  it("[tag:team-options][tag:hook] returns empty + error when there is no data", () => {
    mockUseListAgentsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    const { result } = renderHookWithProject(() => useTeamAgentOptions());
    expect(result.current.entities).toEqual([]);
    expect(result.current.items).toEqual([]);
    expect(result.current.isError).toBe(true);
  });
});

describe("useTeamTeamOptions", () => {
  it("[tag:team-options][tag:hook] maps agent teams to sub-entities and items", () => {
    mockUseListAgentTeamsQuery.mockReturnValue({
      data: [
        {
          id: "tm1",
          name: "Squad",
          status: "Healthy",
          deploymentStatus: "draft",
          labels: [],
        },
      ] as unknown as AgentTeam[],
      isLoading: true,
      isError: false,
    });
    const { result } = renderHookWithProject(() => useTeamTeamOptions());
    expect(result.current.entities).toEqual([
      {
        id: "tm1",
        name: "Squad",
        status: "healthy",
        deployment: "Draft",
        labels: [],
      },
    ]);
    expect(result.current.items).toEqual([
      { key: "tm1", value: "tm1", label: "Squad" },
    ]);
    expect(result.current.isLoading).toBe(true);
    expect(mockUseListAgentTeamsQuery).toHaveBeenCalledWith(
      { projectId: TEST_PROJECT_ID, limit: 500, include: "dependentsSummary=false" },
      { skip: false },
    );
  });
});
