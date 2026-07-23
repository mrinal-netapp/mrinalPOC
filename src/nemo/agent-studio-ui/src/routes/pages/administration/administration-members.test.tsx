import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { ProjectMemberListResponse } from "@/api/project.types";
import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";
import { AdministrationMembers } from "./administration-members";

const mockAddMember = vi.fn();
const mockRemoveMember = vi.fn();
const mockUpdateRole = vi.fn();

vi.mock("@/api/project-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/project-api.slice")>();
  return {
    ...actual,
    useListProjectMembersQuery: vi.fn(),
    useAddProjectMemberMutation: vi.fn(),
    useRemoveProjectMemberMutation: vi.fn(),
    useUpdateProjectMemberRoleMutation: vi.fn(),
  };
});

vi.mock("./hooks/use-is-project-admin", () => ({
  useIsProjectAdmin: vi.fn(),
}));

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  useAddProjectMemberMutation,
  useListProjectMembersQuery,
  useRemoveProjectMemberMutation,
  useUpdateProjectMemberRoleMutation,
} from "@/api/project-api.slice";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { useIsProjectAdmin } from "./hooks/use-is-project-admin";

const ACTIVE_PROJECT_ID = "projk3m9x2ab";

const MEMBERS_RESPONSE: ProjectMemberListResponse = {
  projectId: ACTIVE_PROJECT_ID,
  members: [
    { userId: "al@example.com", email: "al@example.com", role: "admin" },
    { userId: "ben@example.com", email: "ben@example.com", role: "member" },
  ],
};

function setupMembersQuery(
  overrides: Partial<ReturnType<typeof useListProjectMembersQuery>> = {},
) {
  vi.mocked(useListProjectMembersQuery).mockReturnValue({
    data: MEMBERS_RESPONSE,
    isLoading: false,
    isError: false,
    error: undefined,
    refetch: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useListProjectMembersQuery>);
}

function setupMutations({
  isAdding = false,
  isRemoving = false,
  isUpdating = false,
}: {
  isAdding?: boolean;
  isRemoving?: boolean;
  isUpdating?: boolean;
} = {}) {
  vi.mocked(useAddProjectMemberMutation).mockReturnValue([
    mockAddMember,
    { isLoading: isAdding, reset: vi.fn() } as ReturnType<typeof useAddProjectMemberMutation>[1],
  ]);
  vi.mocked(useRemoveProjectMemberMutation).mockReturnValue([
    mockRemoveMember,
    { isLoading: isRemoving, reset: vi.fn() } as ReturnType<typeof useRemoveProjectMemberMutation>[1],
  ]);
  vi.mocked(useUpdateProjectMemberRoleMutation).mockReturnValue([
    mockUpdateRole,
    { isLoading: isUpdating, reset: vi.fn() } as ReturnType<typeof useUpdateProjectMemberRoleMutation>[1],
  ]);
}

function renderMembers(
  options: {
    isProjectAdmin?: boolean;
    onMemberCountChange?: (count: number) => void;
  } = {},
) {
  vi.mocked(useIsProjectAdmin).mockReturnValue(options.isProjectAdmin ?? true);

  return renderWithProviders(
    <AdministrationMembers onMemberCountChange={options.onMemberCountChange} />,
    {
      preloadedState: {
        projectContext: {
          activeProject: { id: ACTIVE_PROJECT_ID, name: "Marketing Analytics", role: "admin" },
        },
      },
    },
  );
}

describe("AdministrationMembers", () => {
  let resizeObserver: ReturnType<typeof mockResizeObserver>;

  beforeEach(() => {
    resizeObserver = mockResizeObserver();
    setupMembersQuery();
    setupMutations();
    mockAddMember.mockClear();
    mockRemoveMember.mockClear();
    mockUpdateRole.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    resizeObserver.cleanup();
    vi.clearAllMocks();
  });

  it("[tag:administration-members] renders summary cards and member table", async () => {
    renderMembers();

    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_TOTAL)).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_ADMINS)).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.TABLE_TITLE(2))).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Al")).toBeInTheDocument();
      expect(screen.getByText("Ben")).toBeInTheDocument();
    });
  });

  it("[tag:administration-members] shows loading spinner while members are loading", () => {
    setupMembersQuery({ data: undefined, isLoading: true });

    renderMembers();

    expect(document.querySelector(".administration-members__loading")).toBeInTheDocument();
  });

  it("[tag:administration-members] shows load error when members query fails", () => {
    setupMembersQuery({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500 },
    });

    renderMembers();

    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.LOAD_ERROR)).toBeInTheDocument();
  });

  it("[tag:administration-members] shows empty state when project has no members", () => {
    setupMembersQuery({
      data: { projectId: ACTIVE_PROJECT_ID, members: [] },
    });

    renderMembers();

    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.EMPTY_STATE)).toBeInTheDocument();
  });

  it("[tag:administration-members] disables add member for non-admin users", () => {
    renderMembers({ isProjectAdmin: false });

    expect(
      screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL }),
    ).toBeDisabled();
  });

  it("[tag:administration-members] adds a member and shows success toast", async () => {
    const user = userEvent.setup();
    mockAddMember.mockReturnValue({ unwrap: () => Promise.resolve({}) });

    renderMembers();

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL }));
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL), "Carol Jones");
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL), "carol@example.com");
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(mockAddMember).toHaveBeenCalledWith({
        projectId: ACTIVE_PROJECT_ID,
        body: { email: "carol@example.com", role: "viewer" },
      });
    });
    expect(toast.success).toHaveBeenCalledWith(
      ADMINISTRATION_MEMBERS_STRINGS.ADD_SUCCESS("carol@example.com"),
    );
  });

  it("[tag:administration-members] shows duplicate-member error when email already exists", async () => {
    const user = userEvent.setup();

    renderMembers();

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL }));
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL), "Al Smith");
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL), "al@example.com");
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    expect(toast.error).toHaveBeenCalledWith(ADMINISTRATION_MEMBERS_STRINGS.DUPLICATE_MEMBER);
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("[tag:administration-members] edits a member role and shows success toast", async () => {
    const user = userEvent.setup();
    mockUpdateRole.mockReturnValue({ unwrap: () => Promise.resolve({}) });

    renderMembers();

    await user.click(screen.getByRole("button", { name: /Actions for Ben/ }));
    await user.click(await screen.findByText("Edit"));

    expect(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(mockUpdateRole).toHaveBeenCalledWith({
        projectId: ACTIVE_PROJECT_ID,
        body: { email: "ben@example.com", role: "member" },
      });
    });
    expect(toast.success).toHaveBeenCalledWith(ADMINISTRATION_MEMBERS_STRINGS.UPDATE_SUCCESS);
  });

  it("[tag:administration-members] deletes a member after confirmation", async () => {
    const user = userEvent.setup();
    mockRemoveMember.mockReturnValue({ unwrap: () => Promise.resolve({}) });

    renderMembers();

    await user.click(screen.getByRole("button", { name: /Actions for Ben/ }));
    await user.click(await screen.findByText("Delete"));
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.DELETE_CONFIRM_LABEL }));

    await waitFor(() => {
      expect(mockRemoveMember).toHaveBeenCalledWith({
        projectId: ACTIVE_PROJECT_ID,
        body: { email: "ben@example.com" },
      });
    });
    expect(toast.success).toHaveBeenCalledWith(
      ADMINISTRATION_MEMBERS_STRINGS.DELETE_SUCCESS("Ben"),
    );
  });

  it("[tag:administration-members] filters members via search", async () => {
    const user = userEvent.setup();

    renderMembers();

    await user.click(screen.getByRole("button", { name: "Open search" }));
    await user.type(screen.getByPlaceholderText(ADMINISTRATION_MEMBERS_STRINGS.SEARCH_PLACEHOLDER), "ben");

    expect(screen.queryByText("Al")).not.toBeInTheDocument();
    expect(screen.getByText("Ben")).toBeInTheDocument();
    expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.TABLE_TITLE(1))).toBeInTheDocument();
  });

  it("[tag:administration-members] notifies parent when member count changes", async () => {
    const onMemberCountChange = vi.fn();

    renderMembers({ onMemberCountChange });

    await waitFor(() => {
      expect(onMemberCountChange).toHaveBeenCalledWith(2);
    });
  });

  it("[tag:administration-members] shows add error toast when API add fails", async () => {
    const user = userEvent.setup();
    mockAddMember.mockReturnValue({ unwrap: () => Promise.reject(new Error("Server error")) });

    renderMembers();

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL }));
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL), "Carol Jones");
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL), "carol@example.com");
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Server error");
    });
  });

  it("[tag:administration-members] rejects invalid email before calling add mutation", async () => {
    const user = userEvent.setup();

    renderMembers();

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL }));
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL), "Bad Email");
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL), "not-an-email");
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    expect(toast.error).toHaveBeenCalledWith("Enter a valid email address");
    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it("[tag:administration-members] shows update error toast when edit fails", async () => {
    const user = userEvent.setup();
    mockUpdateRole.mockReturnValue({ unwrap: () => Promise.reject(new Error("update failed")) });

    renderMembers();

    await user.click(screen.getByRole("button", { name: /Actions for Ben/ }));
    await user.click(await screen.findByText("Edit"));
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(ADMINISTRATION_MEMBERS_STRINGS.UPDATE_ERROR);
    });
  });

  it("[tag:administration-members] shows delete error toast when delete fails", async () => {
    const user = userEvent.setup();
    mockRemoveMember.mockReturnValue({ unwrap: () => Promise.reject(new Error("delete failed")) });

    renderMembers();

    await user.click(screen.getByRole("button", { name: /Actions for Ben/ }));
    await user.click(await screen.findByText("Delete"));
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.DELETE_CONFIRM_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(ADMINISTRATION_MEMBERS_STRINGS.DELETE_ERROR);
    });
  });

  it("[tag:administration-members] cancels delete dialog without removing member", async () => {
    const user = userEvent.setup();

    renderMembers();

    await user.click(screen.getByRole("button", { name: /Actions for Ben/ }));
    await user.click(await screen.findByText("Delete"));
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.DELETE_CANCEL_LABEL }));

    expect(mockRemoveMember).not.toHaveBeenCalled();
    expect(screen.getByText("Ben")).toBeInTheDocument();
  });

  it("[tag:administration-members] opens edit form from member name link", async () => {
    const user = userEvent.setup();

    renderMembers();

    await user.click(screen.getByRole("button", { name: "Al" }));

    expect(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL })).toBeInTheDocument();
    expect(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL)).toHaveValue("al@example.com");
  });

  it("[tag:administration-members] clears search when search panel is closed", async () => {
    const user = userEvent.setup();

    renderMembers();

    await user.click(screen.getByRole("button", { name: "Open search" }));
    const searchInput = screen.getByPlaceholderText(ADMINISTRATION_MEMBERS_STRINGS.SEARCH_PLACEHOLDER);
    await user.type(searchInput, "ben");
    expect(searchInput).toHaveValue("ben");

    await user.click(screen.getByRole("button", { name: "Close search" }));
    await user.click(screen.getByRole("button", { name: "Open search" }));
    expect(screen.getByPlaceholderText(ADMINISTRATION_MEMBERS_STRINGS.SEARCH_PLACEHOLDER)).toHaveValue("");
    expect(screen.getByText("Al")).toBeInTheDocument();
  });

  async function selectAdminRole(user: ReturnType<typeof userEvent.setup>, container: HTMLElement) {
    const trigger = container.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]');
    if (!trigger) throw new Error("Role select trigger not found");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Admin" }));
  }

  it("[tag:administration-members] adds member as admin without showing a confirmation dialog", async () => {
    const user = userEvent.setup();
    mockAddMember.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    const { container } = renderMembers();

    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL }));
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL), "Carol Jones");
    await user.type(screen.getByLabelText(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL), "carol@example.com");
    await selectAdminRole(user, container);
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(mockAddMember).toHaveBeenCalledWith({
        projectId: ACTIVE_PROJECT_ID,
        body: { email: "carol@example.com", role: "admin" },
      });
    });
    expect(toast.success).toHaveBeenCalledWith(
      ADMINISTRATION_MEMBERS_STRINGS.ADD_SUCCESS("carol@example.com"),
    );
  });

  it("[tag:administration-members] promotes a member to admin without showing a confirmation dialog", async () => {
    const user = userEvent.setup();
    mockUpdateRole.mockReturnValue({ unwrap: () => Promise.resolve({}) });
    const { container } = renderMembers();

    await user.click(screen.getByRole("button", { name: /Actions for Ben/ }));
    await user.click(await screen.findByText("Edit"));
    await selectAdminRole(user, container);
    await user.click(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(mockUpdateRole).toHaveBeenCalledWith({
        projectId: ACTIVE_PROJECT_ID,
        body: { email: "ben@example.com", role: "admin" },
      });
    });
    expect(toast.success).toHaveBeenCalledWith(ADMINISTRATION_MEMBERS_STRINGS.UPDATE_SUCCESS);
  });

  it("[tag:administration-members] uses local stub rows when members API returns 401 in dev", () => {
    setupMembersQuery({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 401 },
    });

    renderMembers();

    if (import.meta.env.DEV) {
      expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.STUB_PREVIEW_BANNER)).toBeInTheDocument();
      expect(screen.getByText("Al Smith")).toBeInTheDocument();
    } else {
      expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.LOAD_ERROR)).toBeInTheDocument();
    }
  });
});
