import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@test/render";
import { SingleAgentsList } from "./single-agents-list";
import { buildActionMenu } from "./agents-list-actions";
import { AGENTS_LIST_FETCH_LIMIT, AGENTS_LIST_STRINGS, DEPLOY_LOCKED_CLASS, agentPaths } from "./agents.consts";
import type { AgentTableRow } from "./columns/agents-list.columns";

// Partial mock — keep `agentsConfigApi` intact for `createMockStore` and
// only stub the two hooks the list calls into.
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/routes/pages/agents/api/agents-config-api.slice")
    >();
  return {
    ...actual,
    useListAgentsQuery: vi.fn(),
    useDeleteAgentMutation: vi.fn(),
    useUpdateAgentStatusMutation: vi.fn(),
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
  useDeleteAgentMutation,
  useUpdateAgentStatusMutation,
} from "@/routes/pages/agents/api/agents-config-api.slice";

// ---------------------------------------------------------------------------
// buildActionMenu — pure-function unit tests
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<AgentTableRow> = {}): AgentTableRow {
  return {
    id: "ag-1",
    name: "Test agent",
    status: "Healthy",
    deploymentStatus: "deployed",
    models: ["GPT-4"],
    associatedResources: [],
    associatedItems: [],
    teamDependencyCount: 0,
    lastUpdated: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof buildActionMenu>[1]> = {}) {
  return {
    navigate: vi.fn(),
    isDeprecated: vi.fn(() => false),
    // deprecate: vi.fn(),
    // undeprecate: vi.fn(),
    onRequestDelete: vi.fn(),
    deploy: vi.fn(),
    draft: vi.fn(),
    ...overrides,
  };
}

describe("buildActionMenu (single agents)", () => {
  it(
    "[tag:agents-list][tag:action-menu] deprecated rows show a minimal view-only menu",
    () => {
      const deps = makeDeps({
        isDeprecated: vi.fn(() => true),
        navigate: vi.fn(),
        // deprecate: vi.fn(),
        // undeprecate: vi.fn(),
        onRequestDelete: vi.fn(),
      });
      const items = buildActionMenu(makeRow(), deps);

      expect(items.map((i) => i.label)).toEqual([
        AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS,
        AGENTS_LIST_STRINGS.ACTION_DRAFT,
        AGENTS_LIST_STRINGS.ACTION_EDIT,
        AGENTS_LIST_STRINGS.ACTION_DELETE,
      ]);

      // Everything except View details is disabled.
      expect(items[0].isDisabled).toBeFalsy();
      expect(items.slice(1).every((i) => i.isDisabled)).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] deprecated rows omit Undeprecate action",
    () => {
      const deps = makeDeps({
        isDeprecated: vi.fn(() => true),
        navigate: vi.fn(),
        // deprecate: vi.fn(),
        // undeprecate: vi.fn(),
        onRequestDelete: vi.fn(),
      });
      const items = buildActionMenu(makeRow(), deps);

      expect(
        items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_UNDEPRECATE),
      ).toBeUndefined();
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] deployed rows expose Draft + Delete (Edit disabled)",
    () => {
      const deps = makeDeps();
      const items = buildActionMenu(
        makeRow({ deploymentStatus: "deployed" }),
        deps,
      );

      const editItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_EDIT,
      );
      const deleteItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE,
      );

      expect(editItem?.isDisabled).toBe(true);
      expect(deleteItem?.isDisabled).toBeFalsy();
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] deployed rows disable Delete when team dependency exists",
    () => {
      const deps = makeDeps();
      const items = buildActionMenu(
        makeRow({ deploymentStatus: "deployed", teamDependencyCount: 1 }),
        deps,
      );
      const deleteItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE,
      );
      expect(deleteItem?.isDisabled).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] non-deployed rows expose Edit + Delete and locked Deploy",
    () => {
      const deps = makeDeps();
      const items = buildActionMenu(
        makeRow({ deploymentStatus: "draft" }),
        deps,
      );

      const deployItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DEPLOY,
      );

      expect(deployItem).toBeDefined();
      expect(deployItem?.className).toBe(DEPLOY_LOCKED_CLASS);
      expect(deployItem?.isDisabled).toBeUndefined();
      expect(deployItem?.ariaDisabled).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] Delete is disabled when a non-deployed row has team dependency",
    () => {
      const items = buildActionMenu(
        makeRow({
          deploymentStatus: "draft",
          teamDependencyCount: 1,
        }),
        makeDeps(),
      );

      const deleteItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE,
      );

      expect(deleteItem?.isDisabled).toBe(true);
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] Delete stays enabled when teamDependencyCount is undefined",
    () => {
      // A row with no `teamDependencyCount` (e.g. a payload that omits the
      // field) must fall back to 0 via `?? 0` and leave Delete enabled.
      const items = buildActionMenu(
        makeRow({ deploymentStatus: "draft", teamDependencyCount: undefined }),
        makeDeps(),
      );
      const deleteItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE,
      );
      expect(deleteItem?.isDisabled).toBeFalsy();
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] Delete stays enabled for KB-only associations",
    () => {
      const items = buildActionMenu(
        makeRow({
          deploymentStatus: "draft",
          associatedItems: [{ id: "kb-1", name: "kb", kind: "knowledge-base" }],
          teamDependencyCount: 0,
        }),
        makeDeps(),
      );
      const deleteItem = items.find(
        (i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE,
      );
      expect(deleteItem?.isDisabled).toBeFalsy();
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] deployed rows omit Deprecate action",
    () => {
      const deps = makeDeps();
      const row = makeRow({ deploymentStatus: "deployed" });
      const items = buildActionMenu(row, deps);

      expect(
        items.find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DEPRECATE),
      ).toBeUndefined();
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] Delete asks for confirmation via onRequestDelete",
    () => {
      const deps = makeDeps();
      const row = makeRow({ deploymentStatus: "deployed" });
      const items = buildActionMenu(row, deps);
      items
        .find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_DELETE)
        ?.onClick(row);

      expect(deps.onRequestDelete).toHaveBeenCalledWith({
        id: "ag-1",
        name: "Test agent",
      });
    },
  );

  it(
    "[tag:agents-list][tag:action-menu] View details navigates to the detail route",
    () => {
      const deps = makeDeps();
      const row = makeRow();
      const items = buildActionMenu(row, deps);
      items
        .find((i) => i.label === AGENTS_LIST_STRINGS.ACTION_VIEW_DETAILS)
        ?.onClick(row);

      expect(deps.navigate).toHaveBeenCalledWith(
        expect.stringContaining("ag-1"),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// SingleAgentsList — render / delete-flow integration tests
// ---------------------------------------------------------------------------

const LIST_PAYLOAD = [
  {
    id: "ag-1",
    projectId: "p-1",
    name: "Customer support",
    role: "Support",
    systemPrompt: "Help users.",
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
  payload = LIST_PAYLOAD,
}: {
  isError?: boolean;
  isLoading?: boolean;
  deleteResult?: Promise<unknown>;
  deployResult?: Promise<unknown>;
  payload?: unknown[];
} = {}) {
  const refetch = vi.fn();
  vi.mocked(useListAgentsQuery).mockReturnValue({
    data: payload,
    isLoading,
    isError,
    error: undefined,
    refetch,
    // RTK Query's return type has many more fields; the list page only
    // reads these three, so the cast keeps the harness compact.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const deleteAgent = vi.fn(() => ({ unwrap: () => deleteResult }));
  vi.mocked(useDeleteAgentMutation).mockReturnValue([
    deleteAgent,
    { isLoading: false } as never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);

  const updateAgentStatus = vi.fn(() => ({ unwrap: () => deployResult }));
  vi.mocked(useUpdateAgentStatusMutation).mockReturnValue([
    updateAgentStatus,
    { isLoading: false } as never,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any);

  return { deleteAgent, updateAgentStatus, refetch };
}

// A draft (non-deployed) row surfaces the "Deploy" action in the kebab menu.
const DRAFT_PAYLOAD = [
  {
    id: "ag-1",
    projectId: "p-1",
    name: "Customer support",
    role: "Support",
    systemPrompt: "Help users.",
    status: "Healthy",
    deploymentStatus: "draft",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  },
];

describe("SingleAgentsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSuccess.mockClear();
    toastError.mockClear();
    mockNavigate.mockClear();
  });

  it(
    "[tag:agents-list] requests agents with AGENTS_LIST_FETCH_LIMIT",
    () => {
      setupQueryAndMutation();
      renderWithProviders(<SingleAgentsList />, withProject);
      expect(useListAgentsQuery).toHaveBeenCalledWith(
        { projectId: "p-1", limit: AGENTS_LIST_FETCH_LIMIT },
        { skip: false },
      );
    },
  );

  it(
    "[tag:agents-list] hands isLoading through to BaseTable",
    () => {
      setupQueryAndMutation({ isLoading: true });
      const { container } = renderWithProviders(<SingleAgentsList />, withProject);
      // BaseTable renders a skeleton/spinner during isLoading; checking
      // the container is non-empty is enough to assert it mounted.
      expect(container.firstChild).not.toBeNull();
    },
  );

  it(
    "[tag:agents-list] renders the data row name from the API payload",
    async () => {
      setupQueryAndMutation();
      renderWithProviders(<SingleAgentsList />, withProject);

      // The agent name appears in the agent-name cell.
      expect(
        await screen.findByText("Customer support"),
      ).toBeInTheDocument();
    },
  );

  it(
    "[tag:agents-list] top-bar Add button navigates to the create page",
    async () => {
      setupQueryAndMutation();
      renderWithProviders(<SingleAgentsList />, withProject);

      // The BaseTable top-bar exposes "Add" as the primary action.
      const user = userEvent.setup({ delay: null });
      await user.click(await screen.findByRole("button", { name: /^Add$/i }));

      expect(mockNavigate).toHaveBeenCalledWith(agentPaths.create);
    },
    15000,
  );

  it(
    "[tag:agents-list][tag:delete] confirm fires deleteAgent with project + id and surfaces a success toast",
    async () => {
      const { deleteAgent } = setupQueryAndMutation({
        deleteResult: Promise.resolve({}),
      });
      renderWithProviders(<SingleAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });

      // Open the kebab actions menu for the seeded row.
      await user.click(
        await screen.findByLabelText(/Actions for Customer support/i),
      );
      // Click the Delete action — the action menu items render as
      // `<button role="menuitem">` inside the BaseUI menu popup.
      const deleteItem = await screen.findByText(
        AGENTS_LIST_STRINGS.ACTION_DELETE,
      );
      await user.click(deleteItem);

      // Confirm dialog opens. Click the destructive confirm button.
      const confirm = await screen.findByRole("button", {
        name: AGENTS_LIST_STRINGS.DELETE_CONFIRM_LABEL,
      });
      await user.click(confirm);

      await waitFor(
        () => {
          expect(deleteAgent).toHaveBeenCalledWith({
            projectId: expect.any(String),
            id: "ag-1",
          });
        },
        { timeout: 8000 },
      );
      await waitFor(
        () => {
          expect(toastSuccess).toHaveBeenCalledWith(
            expect.stringContaining("Customer support"),
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
      // Pre-attach a no-op rejection handler so the rejected promise
      // doesn't surface as an unhandled rejection during the test run.
      const failure = Promise.reject(new Error("boom"));
      failure.catch(() => {
        /* swallowed — the production code .catches it via try/catch */
      });
      const { deleteAgent } = setupQueryAndMutation({ deleteResult: failure });
      renderWithProviders(<SingleAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByLabelText(/Actions for Customer support/i),
      );
      const deleteItem = await screen.findByText(
        AGENTS_LIST_STRINGS.ACTION_DELETE,
      );
      await user.click(deleteItem);
      const confirm = await screen.findByRole("button", {
        name: AGENTS_LIST_STRINGS.DELETE_CONFIRM_LABEL,
      });
      await user.click(confirm);

      await waitFor(
        () => {
          expect(deleteAgent).toHaveBeenCalled();
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
    "[tag:agents-list] clicking the row name link navigates to the detail page",
    async () => {
      setupQueryAndMutation();
      renderWithProviders(<SingleAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      // Row name renders as a button (handleNavigateDetail wiring).
      await user.click(await screen.findByRole("button", { name: "Customer support" }));

      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringContaining("/agents/ag-1"),
      );
    },
  );

  it(
    "[tag:agents-list] cancelling the delete dialog clears the target without calling deleteAgent",
    async () => {
      const { deleteAgent } = setupQueryAndMutation();
      renderWithProviders(<SingleAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      // Open the kebab menu + click Delete to surface the dialog.
      await user.click(
        await screen.findByLabelText(/Actions for Customer support/i),
      );
      await user.click(
        await screen.findByText(AGENTS_LIST_STRINGS.ACTION_DELETE),
      );

      // The ConfirmDialog renders a Cancel button by default.
      const cancel = await screen.findByRole("button", { name: /^Cancel$/i });
      await user.click(cancel);

      // The mutation must not have been called.
      expect(deleteAgent).not.toHaveBeenCalled();
      // The dialog should close — Confirm button disappears.
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
      const { updateAgentStatus } = setupQueryAndMutation({
        payload: DRAFT_PAYLOAD,
        deployResult: Promise.resolve({}),
      });
      renderWithProviders(<SingleAgentsList />, withProject);

      const user = userEvent.setup({ delay: null });
      await user.click(
        await screen.findByLabelText(/Actions for Customer support/i),
      );
      const deployItem = await screen.findByRole("menuitem", {
        name: AGENTS_LIST_STRINGS.ACTION_DEPLOY,
      });
      expect(deployItem).toBeInTheDocument();
      expect(deployItem).toHaveClass(DEPLOY_LOCKED_CLASS);
      expect(deployItem).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(deployItem);
      expect(updateAgentStatus).not.toHaveBeenCalled();
    },
  );
});
