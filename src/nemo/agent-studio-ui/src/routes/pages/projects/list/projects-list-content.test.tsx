import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { AccessibleProject } from "../hooks/use-accessible-projects";
import { PROJECT_DELETE_STRINGS } from "../create-edit/project-form.consts";
import { PROJECTS_LIST_STRINGS, projectsPaths } from "../projects.consts";
import { ROUTE_PATHS } from "@/routes/routes.consts";
import { ProjectsListContent } from "./projects-list-content";

const mockNavigate = vi.fn();
const mockDeleteProject = vi.fn();
const mockSwitchProject = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/contexts/project", () => ({
  useProject: () => ({
    activeProject: { id: "proj-other", name: "Other Project", role: "admin" },
    switchProject: mockSwitchProject,
  }),
}));

vi.mock("@/api/project-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/project-api.slice")>();
  return {
    ...actual,
    useDeleteProjectMutation: vi.fn(),
  };
});

vi.mock("../hooks/use-accessible-projects", () => ({
  useAccessibleProjects: vi.fn(),
}));

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useDeleteProjectMutation } from "@/api/project-api.slice";
import { useAccessibleProjects } from "../hooks/use-accessible-projects";
import { toast } from "@/ui-lib/base-components/toast/toast";

const ACCESSIBLE_PROJECT: AccessibleProject = {
  id: "projk3m9x2ab",
  name: "Marketing Analytics",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Team workspace" },
  home_dir: "s3://default-nemo/projects/projk3m9x2ab",
  membershipRole: "admin",
  roleLabel: "Admin",
  isAdmin: true,
};

function setupMocks({
  projects = [ACCESSIBLE_PROJECT],
  isLoading = false,
  isError = false,
  isDeleting = false,
  isProjectAdmin = () => true,
}: {
  projects?: AccessibleProject[];
  isLoading?: boolean;
  isError?: boolean;
  isDeleting?: boolean;
  isProjectAdmin?: (projectId: string) => boolean;
} = {}) {
  vi.mocked(useAccessibleProjects).mockReturnValue({
    projects,
    roleByProjectId: Object.fromEntries(
      projects.map((project) => [project.id, project.membershipRole]),
    ),
    isProjectAdmin,
    isLoading,
    isError,
  });

  vi.mocked(useDeleteProjectMutation).mockReturnValue([
    mockDeleteProject,
    { isLoading: isDeleting, reset: vi.fn() } as unknown as ReturnType<typeof useDeleteProjectMutation>[1],
  ]);
}

describe("ProjectsListContent actions", () => {
  let resizeObserver: ReturnType<typeof mockResizeObserver>;

  beforeEach(() => {
    resizeObserver = mockResizeObserver();
    mockNavigate.mockClear();
    mockDeleteProject.mockClear();
    mockSwitchProject.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    resizeObserver.cleanup();
    vi.clearAllMocks();
  });

  it("[tag:projects-list-content] Edit action navigates to edit route", async () => {
    const user = userEvent.setup();
    setupMocks();
    renderWithProviders(<ProjectsListContent />);

    await user.click(screen.getByRole("button", { name: /Actions for Marketing Analytics/ }));
    await user.click(await screen.findByText("Edit"));

    expect(mockNavigate).toHaveBeenCalledWith("/projects/projk3m9x2ab/edit");
  });

  it("[tag:projects-list-content] confirm delete calls mutation and shows toast", async () => {
    const user = userEvent.setup();
    mockDeleteProject.mockReturnValue({ unwrap: () => Promise.resolve() });
    setupMocks();
    renderWithProviders(<ProjectsListContent />);

    await user.click(screen.getByRole("button", { name: /Actions for Marketing Analytics/ }));
    await user.click(await screen.findByText("Delete"));
    await user.click(await screen.findByRole("button", { name: PROJECT_DELETE_STRINGS.CONFIRM_LABEL }));

    await waitFor(() => {
      expect(mockDeleteProject).toHaveBeenCalledWith("projk3m9x2ab");
    });
    expect(toast.success).toHaveBeenCalledWith(
      PROJECT_DELETE_STRINGS.SUCCESS("Marketing Analytics"),
    );
  });

  it("[tag:projects-list-content] disables edit and delete for non-admin members", async () => {
    setupMocks({
      projects: [{ ...ACCESSIBLE_PROJECT, membershipRole: "member", roleLabel: "Member", isAdmin: false }],
      isProjectAdmin: () => false,
    });
    renderWithProviders(<ProjectsListContent />);

    expect(screen.getByRole("button", { name: /Actions for Marketing Analytics/ })).toBeDisabled();
  });

  it("[tag:projects-list-content] shows error toast when delete fails", async () => {
    const user = userEvent.setup();
    mockDeleteProject.mockReturnValue({
      unwrap: () => Promise.reject(new Error("delete failed")),
    });
    setupMocks();
    renderWithProviders(<ProjectsListContent />);

    await user.click(screen.getByRole("button", { name: /Actions for Marketing Analytics/ }));
    await user.click(await screen.findByText("Delete"));
    await user.click(await screen.findByRole("button", { name: PROJECT_DELETE_STRINGS.CONFIRM_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        PROJECT_DELETE_STRINGS.ERROR("Marketing Analytics"),
      );
    });
  });

  it("[tag:projects-list-content] navigates to create page from add project action", async () => {
    const user = userEvent.setup();
    setupMocks();
    renderWithProviders(<ProjectsListContent />);

    await user.click(screen.getByRole("button", { name: PROJECTS_LIST_STRINGS.ADD_PROJECT_LABEL }));

    expect(mockNavigate).toHaveBeenCalledWith(projectsPaths.create);
  });

  it("[tag:projects-list-content] closes delete dialog without calling mutation on cancel", async () => {
    const user = userEvent.setup();
    setupMocks();
    renderWithProviders(<ProjectsListContent />);

    await user.click(screen.getByRole("button", { name: /Actions for Marketing Analytics/ }));
    await user.click(await screen.findByText("Delete"));
    await user.click(screen.getByRole("button", { name: PROJECT_DELETE_STRINGS.CANCEL_LABEL }));

    expect(mockDeleteProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: PROJECT_DELETE_STRINGS.CONFIRM_LABEL })).not.toBeInTheDocument();
  });

  it("[tag:projects-list-content] switches project and navigates to overview when name is clicked", async () => {
    const user = userEvent.setup();
    setupMocks();
    renderWithProviders(<ProjectsListContent />);

    await user.click(screen.getByRole("button", { name: /Switch to Marketing Analytics/ }));

    expect(mockSwitchProject).toHaveBeenCalledWith("projk3m9x2ab");
    expect(mockNavigate).toHaveBeenCalledWith(ROUTE_PATHS.OVERVIEW);
  });

  it("[tag:projects-list-content] renders loading state while projects are fetching", () => {
    setupMocks({ isLoading: true });
    renderWithProviders(<ProjectsListContent />);

    expect(screen.queryByText("Marketing Analytics")).not.toBeInTheDocument();
    expect(screen.queryByText(PROJECTS_LIST_STRINGS.EMPTY_STATE_WELCOME)).not.toBeInTheDocument();
  });
});
