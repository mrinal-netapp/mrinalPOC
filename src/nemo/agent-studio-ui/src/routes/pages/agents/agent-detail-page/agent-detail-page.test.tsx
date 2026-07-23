import { screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import type { Agent, AgentTeam } from "@/routes/pages/agents/api/agents-config.types";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the component
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// Partial mock — keep the rest of the module intact (the
// `agentsConfigApi` slice export is consumed by `createMockStore`) and
// only stub the two query hooks the page actually calls.
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/routes/pages/agents/api/agents-config-api.slice")
    >();
  return {
    ...actual,
    useGetAgentQuery: vi.fn(),
    useGetAgentTeamQuery: vi.fn(),
    useListAgentsQuery: vi.fn(),
    useListAgentTeamDependentsQuery: vi.fn(),
    useUpdateAgentStatusMutation: vi.fn(),
    useUpdateAgentTeamStatusMutation: vi.fn(),
  };
});

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("./panels/overview-panel", () => ({
  OverviewPanel: () => <div data-testid="overview-panel">Overview panel</div>,
}));

vi.mock("./panels/toolsets-panel", () => ({
  ToolsetsPanel: ({ agentId }: { agentId: string }) => (
    <div data-testid="toolsets-panel">Toolsets panel ({agentId})</div>
  ),
  // The detail page reads `rows.length` from this hook to render the
  // tab count badge. Stub with an empty array; per-test overrides can
  // re-mock with longer fixtures to verify the badge math.
  useAgentToolsets: () => ({
    rows: [],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("./panels/assigned-kb-panel", () => ({
  AssignedKbPanel: ({ agentId }: { agentId: string }) => (
    <div data-testid="assigned-kb-panel">Assigned KB panel ({agentId})</div>
  ),
  useAgentAssignedKbs: () => ({
    rows: [],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("./agent-detail-page.consts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agent-detail-page.consts")>();
  return {
    ...actual,
    SHOW_AGENT_CONFIGURATIONS_TAB: true,
  };
});

import {
  useGetAgentQuery,
  useGetAgentTeamQuery,
  useListAgentsQuery,
  useListAgentTeamDependentsQuery,
  useUpdateAgentStatusMutation,
  useUpdateAgentTeamStatusMutation,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import { agentPaths, DEPLOY_LOCKED_CLASS } from "../agents.consts";
import { AgentDetailPage } from "./agent-detail-page";

/**
 * Stubs the deploy/draft status mutations. Both detail-page status hooks share
 * one mocked trigger so a test can assert the call args and control whether the
 * underlying request resolves or rejects.
 */
function mockStatusMutations(result: Promise<unknown> = Promise.resolve({})) {
  const updateStatus = vi.fn(() => ({ unwrap: () => result }));
  vi.mocked(useUpdateAgentStatusMutation).mockReturnValue([
    updateStatus,
    { isLoading: false } as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);
  vi.mocked(useUpdateAgentTeamStatusMutation).mockReturnValue([
    updateStatus,
    { isLoading: false } as never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);
  return updateStatus;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SINGLE_AGENT_ID = "ag-mcp001";
const TEAM_AGENT_ID = "agr-team001";

const MOCK_AGENT: Agent = {
  id: SINGLE_AGENT_ID,
  projectId: "project-test",
  name: "Customer support agent",
  description: "Tier-1 customer support automation.",
  role: "Customer support specialist",
  outcomeDescription: "Resolve customer queries quickly.",
  systemPrompt: "Always greet the customer professionally.",
  modelId: "gpt-4-turbo",
  knowledgeBaseIds: ["kb-01", "kb-02"],
  mcpServerIds: ["mcp-01", "mcp-02", "mcp-03"],
  status: "Healthy",
  deploymentStatus: "draft",
  createdAt: "2025-11-04T09:30:00Z",
  updatedAt: "2026-02-10T07:15:06Z",
};

const MOCK_TEAM: AgentTeam = {
  id: TEAM_AGENT_ID,
  projectId: "project-test",
  name: "Customer success team",
  description: "Cross-functional support + insights team.",
  manager: {
    name: "Lead manager",
    role: "Customer success manager",
    systemPrompt: "Coordinate sub-agents and escalate when needed.",
    modelId: "gpt-4o",
  },
  members: [
    { memberType: "agent", memberId: "ag-sub001" },
    { memberType: "agent", memberId: "ag-sub002" },
  ],
  sharedKnowledgeBaseIds: ["kb-team-01"],
  status: "Healthy",
  deploymentStatus: "draft",
  createdAt: "2025-12-01T10:00:00Z",
  updatedAt: "2026-02-20T11:00:00Z",
};

type GetAgentResult = ReturnType<typeof useGetAgentQuery>;
type GetTeamResult = ReturnType<typeof useGetAgentTeamQuery>;
type ListAgentsResult = ReturnType<typeof useListAgentsQuery>;
type TeamDependentsResult = ReturnType<typeof useListAgentTeamDependentsQuery>;

function makeQueryResult(overrides: Partial<{
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  status: string;
  isUninitialized: boolean;
}> = {}): GetAgentResult {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
    currentData: undefined,
    endpointName: "getAgent",
    fulfilledTimeStamp: undefined,
    isUninitialized: false,
    originalArgs: undefined,
    requestId: undefined,
    startedTimeStamp: undefined,
    status: "uninitialized",
    ...overrides,
  } as unknown as GetAgentResult;
}

function makeTeamQueryResult(overrides: Partial<{
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  status: string;
  isUninitialized: boolean;
}> = {}): GetTeamResult {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
    currentData: undefined,
    endpointName: "getAgentTeam",
    fulfilledTimeStamp: undefined,
    isUninitialized: false,
    originalArgs: undefined,
    requestId: undefined,
    startedTimeStamp: undefined,
    status: "uninitialized",
    ...overrides,
  } as unknown as GetTeamResult;
}

function makeTeamDependentsResult(overrides: Partial<{
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  isUninitialized: boolean;
}> = {}): TeamDependentsResult {
  return {
    data: undefined,
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    isUninitialized: true,
    error: undefined,
    refetch: vi.fn(),
    currentData: undefined,
    endpointName: "listAgentTeamDependents",
    fulfilledTimeStamp: undefined,
    originalArgs: undefined,
    requestId: undefined,
    startedTimeStamp: undefined,
    status: "uninitialized",
    ...overrides,
  } as unknown as TeamDependentsResult;
}

function makeListAgentsResult(overrides: Partial<{
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  isUninitialized: boolean;
}> = {}): ListAgentsResult {
  return {
    data: [],
    isLoading: false,
    isFetching: false,
    isSuccess: false,
    isError: false,
    isUninitialized: true,
    error: undefined,
    refetch: vi.fn(),
    currentData: undefined,
    endpointName: "listAgents",
    fulfilledTimeStamp: undefined,
    originalArgs: undefined,
    requestId: undefined,
    startedTimeStamp: undefined,
    status: "uninitialized",
    ...overrides,
  } as unknown as ListAgentsResult;
}

const SINGLE_SUCCESS = makeQueryResult({
  data: MOCK_AGENT,
  isSuccess: true,
  status: "fulfilled",
});

const TEAM_SUCCESS = makeTeamQueryResult({
  data: MOCK_TEAM,
  isSuccess: true,
  status: "fulfilled",
});

const SKIPPED = makeQueryResult({
  isUninitialized: true,
  status: "uninitialized",
});

const TEAM_SKIPPED = makeTeamQueryResult({
  isUninitialized: true,
  status: "uninitialized",
});

const TEAM_DEPENDENTS_SKIPPED = makeTeamDependentsResult({
  isUninitialized: true,
});
const LIST_AGENTS_SKIPPED = makeListAgentsResult({
  isUninitialized: true,
});

function renderAgentDetailPage(agentId: string = SINGLE_AGENT_ID) {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/agents/:agentId", element: <AgentDetailPage /> },
      { path: "/agents", element: <div data-testid="agents-list" /> },
    ],
    initialEntries: [`/agents/${agentId}`],
    preloadedState: {
      projectContext: {
        activeProject: { id: "project-test", name: "", role: "admin" },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useListAgentsQuery).mockReturnValue(LIST_AGENTS_SKIPPED);
    vi.mocked(useListAgentTeamDependentsQuery).mockReturnValue(
      TEAM_DEPENDENTS_SKIPPED,
    );
    mockStatusMutations();
  });

  it("[tag:agent-detail][tag:loading] shows loading state while fetching a single agent", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({ isLoading: true, status: "pending" }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("[tag:agent-detail][tag:loading] shows loading state while fetching a team agent", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(
      makeTeamQueryResult({ isLoading: true, status: "pending" }),
    );
    renderAgentDetailPage(TEAM_AGENT_ID);

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("[tag:agent-detail][tag:error] shows error message on generic failure", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 500, data: undefined }, status: "rejected" }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByText("Failed to load agent.")).toBeInTheDocument();
  });

  it("[tag:agent-detail][tag:not-found] shows not found message on 404", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 404, data: undefined }, status: "rejected" }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
  });

  it("[tag:agent-detail][tag:not-found] shows not found on 404 even when stale data is still cached", () => {
    // RTK Query retains the last successful `data` when a subsequent request
    // errors. Simulate: an agent loaded successfully, then was deleted on the
    // backend; the next refetch returns 404 but `data` is still populated.
    // The page MUST render the not-found UI, not fall through to stale success.
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({
        data: MOCK_AGENT,
        isError: true,
        error: { status: 404, data: undefined },
        status: "rejected",
      }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("[tag:agent-detail][tag:not-found] shows not found when both queries return no data", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({ data: undefined, isSuccess: true, status: "fulfilled" }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
  });

  it("[tag:agent-detail][tag:not-found] renders not-found and skips every query when no agentId is in the route", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    // Mount the page on a route with no `:agentId` param so `agentId` is
    // undefined. This exercises the `agentId ?? ""` fallbacks and the
    // `!agentId` deprecation guard, and the page must still degrade to the
    // not-found state.
    renderWithProviders(undefined, {
      routeConfig: [
        { path: "/detail-no-id", element: <AgentDetailPage /> },
        { path: "/agents", element: <div data-testid="agents-list" /> },
      ],
      initialEntries: ["/detail-no-id"],
      preloadedState: {
        projectContext: {
          activeProject: { id: "project-test", name: "", role: "admin" },
        },
      },
    });

    expect(screen.getByText("Agent not found.")).toBeInTheDocument();
    expect(useGetAgentQuery).toHaveBeenCalledWith(
      { projectId: "project-test", id: "" },
      { skip: true },
    );
    expect(useGetAgentTeamQuery).toHaveBeenCalledWith(
      { projectId: "project-test", id: "" },
      { skip: true },
    );
  });

  it("[tag:agent-detail][tag:not-found] back button navigates to Agents list on not-found", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({ isError: true, error: { status: 404, data: undefined }, status: "rejected" }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Back to Agents" }));
    expect(mockNavigate).toHaveBeenCalledWith("/agents");
  });

  it("[tag:agent-detail] success state renders the page title and breadcrumb", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByText("Agent details")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getAllByText(MOCK_AGENT.name).length).toBeGreaterThanOrEqual(1);
  });

  it("[tag:agent-detail] success state renders summary field values", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("gpt-4-turbo")).toBeInTheDocument();
  });

  it("[tag:agent-detail] Overview tab is active by default", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    expect(screen.getByTestId("overview-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("toolsets-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assigned-kb-panel")).not.toBeInTheDocument();
  });

  it(
    "[tag:agent-detail] Toolsets tab label includes the row count from the hook",
    () => {
      // The hook is stubbed with `rows: []` above, so the badge reads
      // `(0)`. Override the mock at the suite level once the real
      // endpoint lands to assert non-zero counts.
      vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
      vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
      renderAgentDetailPage(SINGLE_AGENT_ID);

      expect(
        screen.getByRole("tab", { name: "Toolsets (0)" }),
      ).toBeInTheDocument();
    },
  );

  it("[tag:agent-detail] switching to Toolsets tab passes agentId to the panel", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByRole("tab", { name: "Toolsets (0)" }));

    expect(await screen.findByTestId("toolsets-panel")).toHaveTextContent(
      `Toolsets panel (${SINGLE_AGENT_ID})`,
    );
  }, 15000);

  it("[tag:agent-detail] switching to Assigned KB tab passes agentId to the panel", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(
      await screen.findByRole("tab", { name: "Assigned knowledge bases (0)" }),
    );

    expect(await screen.findByTestId("assigned-kb-panel")).toHaveTextContent(
      `Assigned KB panel (${SINGLE_AGENT_ID})`,
    );
  }, 15000);

  it(
    "[tag:agent-detail] Configurations tab renders the read-only feature cards for a single agent",
    async () => {
      // The tab is gated behind `SHOW_AGENT_CONFIGURATIONS_TAB`. The mock
      // agent enables no feature cards, so the count is (0) and every card
      // shows "Disabled". The card content itself is covered in depth by
      // configurations-panel.test.tsx.
      vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
      vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
      renderAgentDetailPage(SINGLE_AGENT_ID);

      const tab = screen.getByRole("tab", { name: "Configurations (0)" });
      expect(tab).toBeInTheDocument();

      const user = userEvent.setup({ delay: null });
      await user.click(tab);

      // One card per feature, read-only (no Configure/Enable controls).
      expect(await screen.findByText("Structured output")).toBeInTheDocument();
      expect(
        screen.getByText("Conversation memory and context"),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /enable|configure/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("[tag:agent-detail][tag:team] team-agent id triggers the team query and renders the team name", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SUCCESS);
    renderAgentDetailPage(TEAM_AGENT_ID);

    expect(useListAgentTeamDependentsQuery).toHaveBeenCalledWith(
      { projectId: "project-test", id: TEAM_AGENT_ID, kind: "agent_team" },
      { skip: false },
    );
    expect(screen.getAllByText(MOCK_TEAM.name).length).toBeGreaterThanOrEqual(1);
  });

  it("[tag:agent-detail] Refresh button calls the active query's refetch", async () => {
    const refetch = vi.fn();
    vi.mocked(useGetAgentQuery).mockReturnValue({
      ...SINGLE_SUCCESS,
      refetch,
    } as GetAgentResult);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("[tag:agent-detail][tag:edit] Edit button navigates to the agent edit page", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(mockNavigate).toHaveBeenCalledWith(agentPaths.edit(SINGLE_AGENT_ID), {
      state: { returnTo: agentPaths.detail(SINGLE_AGENT_ID) },
    });
  });

  it("[tag:agent-detail] Actions dropdown trigger is enabled for a healthy agent", () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(trigger).toBeEnabled();
  });

  it("[tag:agent-detail][tag:deploy] Deploy is locked while LOCK_AGENT_DEPLOY is true", async () => {
    const updateStatus = mockStatusMutations();
    vi.mocked(useGetAgentQuery).mockReturnValue(SINGLE_SUCCESS);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deployItem = await screen.findByRole("menuitem", { name: "Deploy" });
    expect(deployItem).toBeInTheDocument();
    expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS);
    expect(deployItem).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(deployItem);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("[tag:agent-detail][tag:deploy] devtools-unlock path still respects blocking requirements", async () => {
    const updateStatus = mockStatusMutations();
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({
        data: {
          ...MOCK_AGENT,
          requirements: {
            knowledgeBases: [
              { id: "kb-req", label: "Required KB", description: "", required: true },
            ],
          },
        },
        isSuccess: true,
        status: "fulfilled",
      }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deployItem = await screen.findByRole("menuitem", { name: "Deploy" });

    // Simulate the documented QA unlock (removing the marker in devtools): the
    // JS lock guard releases, but the requirements gate must still block deploy.
    deployItem.classList.remove(DEPLOY_LOCKED_CLASS);
    fireEvent.click(deployItem);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("[tag:agent-detail][tag:delete] disables Delete for a single agent referenced by a team", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(
      makeQueryResult({
        data: {
          ...MOCK_AGENT,
          associatedResources: {
            knowledgeBases: [],
            agentTeams: [{ id: "agr-parent", name: "Parent Team" }],
          },
        },
        isSuccess: true,
        status: "fulfilled",
      }),
    );
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SKIPPED);
    renderAgentDetailPage(SINGLE_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
  });

  it("[tag:agent-detail][tag:delete] disables Delete for a team agent referenced by another team", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(
      makeTeamQueryResult({
        data: {
          ...MOCK_TEAM,
        },
        isSuccess: true,
        status: "fulfilled",
      }),
    );
    vi.mocked(useListAgentTeamDependentsQuery).mockReturnValue(
      makeTeamDependentsResult({
        data: {
          items: [],
          nextCursor: null,
          totalByKind: { "agent-team": 1 },
        },
        isSuccess: true,
        isUninitialized: false,
      }),
    );
    renderAgentDetailPage(TEAM_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
  });

  it("[tag:agent-detail][tag:delete] disables Delete for a team while dependents are loading", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SUCCESS);
    vi.mocked(useListAgentTeamDependentsQuery).mockReturnValue(
      makeTeamDependentsResult({
        isLoading: true,
        isFetching: true,
        isUninitialized: false,
      }),
    );
    renderAgentDetailPage(TEAM_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
  });

  it("[tag:agent-detail][tag:delete] disables Delete for a team when dependents check errors", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SUCCESS);
    vi.mocked(useListAgentTeamDependentsQuery).mockReturnValue(
      makeTeamDependentsResult({
        isError: true,
        isUninitialized: false,
      }),
    );
    renderAgentDetailPage(TEAM_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
  });

  it("[tag:agent-detail][tag:delete] enables Delete for a team when dependents check succeeds with no parent teams", async () => {
    vi.mocked(useGetAgentQuery).mockReturnValue(SKIPPED);
    vi.mocked(useGetAgentTeamQuery).mockReturnValue(TEAM_SUCCESS);
    vi.mocked(useListAgentTeamDependentsQuery).mockReturnValue(
      makeTeamDependentsResult({
        data: {
          items: [],
          nextCursor: null,
          totalByKind: { "agent-team": 0 },
        },
        isSuccess: true,
        isUninitialized: false,
      }),
    );
    renderAgentDetailPage(TEAM_AGENT_ID);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
    expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
  });
});
