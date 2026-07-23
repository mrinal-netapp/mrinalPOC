import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@test/render";
import { TeamAgentsList } from "./team-agents-list";
import { buildActionMenu } from "./agents-list-actions";
import { AGENTS_LIST_FETCH_LIMIT, AGENTS_LIST_STRINGS, DEPLOY_LOCKED_CLASS, agentPaths } from "./agents.consts";
import type { AgentTableRow } from "./columns/agents-list.columns";

// Partial mock — `agentsConfigApi` must stay real for `createMockStore`.
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/routes/pages/agents/api/agents-config-api.slice")
    >();
  return {
    ...actual,
    useListAgentsQuery: vi.fn(),
    useListAgentTeamsQuery: vi.fn(),
    useDeleteAgentTeamMutation: vi.fn(),
    useUpdateAgentTeamStatusMutation: vi.fn(),
  };
});

const mockNavigate = vi.fn();
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
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

import {
  useListAgentsQuery,
  useListAgentTeamsQuery,
  useDeleteAgentTeamMutation,
  useUpdateAgentTeamStatusMutation,
} from "@/routes/pages/agents/api/agents-config-api.slice";

// ---------------------------------------------------------------------------
// buildActionMenu — pure-function unit tests
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<AgentTableRow> = {}): AgentTableRow {
  return {
    id: "agr-1",
    name: "Test team",
    status: "Healthy",
    deploymentStatus: "deployed",
    models: ["GPT-4"],
    associatedAgents: [],
    associatedItems: [],
    teamDependencyCount: 0,
    lastUpdated: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function makeDeps() {
  return {
    navigate: vi.fn(),
    isDeprecated: vi.fn(() => false),
    // deprecate: vi.fn(),
    // undeprecate: vi.fn(),
    onRequestDelete: vi.fn(),
    deploy: vi.fn(),
    draft: vi.fn(),
  };
}

describe("buildActionMenu (team agents)", () => {
  it(
    "[tag:agents-list][tag:action-menu] deprecated rows show view-only menu",
    () => {
      const deps = makeDeps();
      deps.isDeprecated = vi.fn(() => true);

      const items = buildActionMenu(makeRow(), deps);

      expect(items.map((i) => i.label)).toEqual([
        AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS,
        AGENTS_LIST_STRINGS.ACTION_DRAFT,
        AGENTS_LIST_STRINGS.ACTION_EDIT,
        AGENTS_LIST_STRINGS.ACTION_DELETE,
      ]);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] deployed team rows disable Edit",
    () => {
      const items = buildActionMenu(
        makeRow({ deploymentStatus: "deployed" }),
        makeDeps(),
      );
      expect(
        items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_EDIT)
          ?.isDisabled,
      ).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] deployed team rows disable Delete when team dependency exists",
    () => {
      const items = buildActionMenu(
        makeRow({ deploymentStatus: "deployed", teamDependencyCount: 2 }),
        makeDeps(),
      );
      expect(
        items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)
          ?.isDisabled,
      ).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] non-deployed rows disable Delete when team has dependents",
    () => {
      const items = buildActionMenu(
        makeRow({
          deploymentStatus: "draft",
          teamDependencyCount: 1,
        }),
        makeDeps(),
      );
      expect(
        items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)
          ?.isDisabled,
      ).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] non-deployed rows keep Delete enabled when only member associations exist",
    () => {
      const items = buildActionMenu(
        makeRow({
          deploymentStatus: "draft",
          associatedItems: [{ id: "ag-1", name: "member-bot", kind: "agent" }],
          teamDependencyCount: 0,
        }),
        makeDeps(),
      );
      expect(
        items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)
          ?.isDisabled,
      ).toBeFalsy();
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] Deploy is locked in draft row menu while LOCK_AGENT_DEPLOY is true",
    () => {
      const deps = makeDeps();
      const row = makeRow({ deploymentStatus: "draft" });
      const items = buildActionMenu(row, deps);
      const deployItem = items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DEPLOY);
      expect(deployItem).toBeDefined();
      expect(deployItem?.className).toBe(DEPLOY_LOCKED_CLASS);
      expect(deployItem?.isDisabled).toBeUndefined();
      expect(deployItem?.ariaDisabled).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// TeamAgentsList — render / delete-flow integration tests
// ---------------------------------------------------------------------------

const TEAM_PAYLOAD = [
  {
    id: "agr-1",
    projectId: "p-1",
    name: "Support pod",
    members: [],
    status: "Healthy",
    deploymentStatus: "deployed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
];

const withProject = {
  preloadedState: {
    projectContext: {
      activeProject: { id: "p-1", name: "", role: "admin" as const },
    },
  },
};

function setupQueryAndMutation({
  isError = false,
  isLoading = false,
  deleteResult = Promise.resolve({}),
  deployResult = Promise.resolve({}),
  payload = TEAM_PAYLOAD,
  singleAgentsPayload = [],
  isSingleAgentsLoading = false,
  isSingleAgentsFetching = false,
  isSingleAgentsUninitialized = false,
  isSingleAgentsError = false,
}: {
  isError?: boolean;
  isLoading?: boolean;
  deleteResult?: Promise<unknown>;
  deployResult?: Promise<unknown>;
  payload?: unknown[];
  singleAgentsPayload?: unknown[];
  isSingleAgentsLoading?: boolean;
  isSingleAgentsFetching?: boolean;
  isSingleAgentsUninitialized?: boolean;
  isSingleAgentsError?: boolean;
} = {}) {
  const refetch = vi.fn();
  vi.mocked(useListAgentTeamsQuery).mockReturnValue({
    data: payload,
    isLoading,
    isError,
    error: undefined,
    refetch,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(useListAgentsQuery).mockReturnValue({
    data: singleAgentsPayload,
    isLoading: isSingleAgentsLoading,
    isFetching: isSingleAgentsFetching,
    isUninitialized: isSingleAgentsUninitialized,
    isError: isSingleAgentsError,
    error: undefined,
    refetch: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const deleteAgentTeam = vi.fn(() => ({ unwrap: () => deleteResult }));
  vi.mocked(useDeleteAgentTeamMutation).mockReturnValue([
    deleteAgentTeam,
    { isLoading: false } as never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);

  const updateAgentTeamStatus = vi.fn(() => ({ unwrap: () => deployResult }));
  vi.mocked(useUpdateAgentTeamStatusMutation).mockReturnValue([
    updateAgentTeamStatus,
    { isLoading: false } as never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);

  return { deleteAgentTeam, updateAgentTeamStatus, refetch };
}

// A draft (non-deployed) team surfaces the "Deploy" action in the kebab menu.
const DRAFT_TEAM_PAYLOAD = [
  {
    id: "agr-1",
    projectId: "p-1",
    name: "Support pod",
    members: [],
    status: "Healthy",
    deploymentStatus: "draft",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
];

describe("TeamAgentsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  it(
    "[tag:agents-list] requests teams with AGENTS_LIST_FETCH_LIMIT",
    () => {
      setupQueryAndMutation();
      renderWithProviders(<TeamAgentsList />, withProject);
      expect(useListAgentTeamsQuery).toHaveBeenCalledWith(
        { projectId: "p-1", limit: AGENTS_LIST_FETCH_LIMIT },
        { skip: false },
      );
    },
  );

  it(
    "[tag:agents-list] renders the team name from the API payload",
    async () => {
      setupQueryAndMutation();
      renderWithProviders(<TeamAgentsList />, withProject);
      expect(await screen.findByText("Support pod")).toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-list] top-bar Add button navigates to the create page",
    async () => {
      setupQueryAndMutation();
      renderWithProviders(<TeamAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(await screen.findByRole("button", { name: /^Add$/i }));

      expect(mockNavigate).toHaveBeenCalledWith(agentPaths.create);
    },
  );

  it(
    "[tag:agents-list][tag:delete] confirm fires deleteAgentTeam and surfaces success toast",
    async () => {
      const { deleteAgentTeam } = setupQueryAndMutation();
      renderWithProviders(<TeamAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByLabelText(/Actions for Support pod/i),
      );
      await user.click(
        await screen.findByText(AGENTS_LIST_STRINGS.ACTION_DELETE),
      );
      await user.click(
        await screen.findByRole("button", {
          name: AGENTS_LIST_STRINGS.DELETE_CONFIRM_LABEL,
        }),
      );

      await waitFor(
        () => {
          expect(deleteAgentTeam).toHaveBeenCalledWith({
            projectId: expect.any(String),
            id: "agr-1",
          });
        },
        { timeout: 8000 },
      );
      await waitFor(
        () => {
          expect(toastSuccess).toHaveBeenCalledWith(
            expect.stringContaining("Support pod"),
          );
        },
        { timeout: 8000 },
      );
    },
    20000,
  );

  it(
    "[tag:agents-list][tag:delete] failure surfaces an error toast",
    async () => {
      const failure = Promise.reject(new Error("boom"));
      failure.catch(() => {
        /* swallowed — the production code .catches via try/catch */
      });
      const { deleteAgentTeam } = setupQueryAndMutation({
        deleteResult: failure,
      });
      renderWithProviders(<TeamAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByLabelText(/Actions for Support pod/i),
      );
      await user.click(
        await screen.findByText(AGENTS_LIST_STRINGS.ACTION_DELETE),
      );
      await user.click(
        await screen.findByRole("button", {
          name: AGENTS_LIST_STRINGS.DELETE_CONFIRM_LABEL,
        }),
      );

      await waitFor(
        () => {
          expect(deleteAgentTeam).toHaveBeenCalled();
        },
        { timeout: 8000 },
      );
      await waitFor(
        () => {
          expect(toastError).toHaveBeenCalledWith(
            expect.stringContaining(AGENTS_LIST_STRINGS.DELETE_FAILURE_PREFIX),
          );
        },
        { timeout: 8000 },
      );
    },
    20000,
  );

  it(
    "[tag:agents-list] clicking the team row name link navigates to the detail page",
    async () => {
      setupQueryAndMutation();
      renderWithProviders(<TeamAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(await screen.findByRole("button", { name: "Support pod" }));

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining("/agents/agr-1"),
      );
    },
  );

  it(
    "[tag:agents-list] cancelling the delete dialog clears the target without calling deleteAgentTeam",
    async () => {
      const { deleteAgentTeam } = setupQueryAndMutation();
      renderWithProviders(<TeamAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByLabelText(/Actions for Support pod/i),
      );
      await user.click(
        await screen.findByText(AGENTS_LIST_STRINGS.ACTION_DELETE),
      );

      const cancel = await screen.findByRole("button", { name: /^Cancel$/i });
      await user.click(cancel);

      expect(deleteAgentTeam).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(
          screen.queryByRole("button", {
            name: AGENTS_LIST_STRINGS.DELETE_CONFIRM_LABEL,
          }),
        ).not.toBeInTheDocument();
      });
    },
    15000,
  );

  it(
    "[tag:agents-list][tag:deploy] Deploy is locked while LOCK_AGENT_DEPLOY is true",
    async () => {
      const { updateAgentTeamStatus } = setupQueryAndMutation({
        payload: DRAFT_TEAM_PAYLOAD,
        deployResult: Promise.resolve({}),
      });
      renderWithProviders(<TeamAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByLabelText(/Actions for Support pod/i),
      );
      const deployItem = await screen.findByRole("menuitem", {
        name: AGENTS_LIST_STRINGS.ACTION_DEPLOY,
      });
      expect(deployItem).toBeInTheDocument();
      expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS);
      expect(deployItem).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(deployItem);
      expect(updateAgentTeamStatus).not.toHaveBeenCalled();
    },
  );
});
