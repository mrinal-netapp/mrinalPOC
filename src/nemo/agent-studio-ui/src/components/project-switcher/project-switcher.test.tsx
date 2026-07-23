import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { renderWithProviders, userEvent } from "@test/render";
import type { AccessibleProject } from "@/routes/pages/projects/hooks/use-accessible-projects";
import { PROJECT_SWITCHER_STRINGS } from "./project-switcher.consts";
import { ProjectSwitcher } from "./project-switcher";

const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/routes/pages/projects/hooks/use-accessible-projects", () => ({
  useAccessibleProjects: vi.fn(),
}));

import { useAccessibleProjects } from "@/routes/pages/projects/hooks/use-accessible-projects";

const ACCESSIBLE_PROJECTS: AccessibleProject[] = [
  {
    id: "proj-alpha",
    name: "Alpha Project",
    created_at: "2026-05-25T14:32:10.123Z",
    updated_at: "2026-05-25T14:32:10.123Z",
    metadata: {},
    home_dir: "s3://default-nemo/projects/proj-alpha",
    membershipRole: "admin",
    roleLabel: "Admin",
    isAdmin: true,
  },
  {
    id: "proj-beta",
    name: "Beta Project",
    created_at: "2026-05-25T14:32:10.123Z",
    updated_at: "2026-05-25T14:32:10.123Z",
    metadata: {},
    home_dir: "s3://default-nemo/projects/proj-beta",
    membershipRole: "member",
    roleLabel: "Member",
    isAdmin: false,
  },
];

function setupAccessibleProjects(
  overrides: Partial<ReturnType<typeof useAccessibleProjects>> = {},
) {
  vi.mocked(useAccessibleProjects).mockReturnValue({
    projects: ACCESSIBLE_PROJECTS,
    roleByProjectId: {
      "proj-alpha": "admin",
      "proj-beta": "member",
    },
    isProjectAdmin: (projectId) => projectId === "proj-alpha",
    isLoading: false,
    isError: false,
    ...overrides,
  });
}

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    setupAccessibleProjects();
  });

  it("[tag:project-switcher] renders trigger with active project name", async () => {
    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
    });

    expect(screen.getByTestId("project-switcher-trigger")).toBeInTheDocument();
    expect(screen.getByText(PROJECT_SWITCHER_STRINGS.TRIGGER_LABEL)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Current project: Alpha Project/ })).toBeInTheDocument();
  });

  it("[tag:project-switcher] opens panel, filters projects, and switches active project", async () => {
    const user = userEvent.setup();
    const switchProject = vi.fn();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      // ProjectSwitcher now reads accessibleProjects from ProjectContext (not the
      // useAccessibleProjects hook), so the module-level vi.mock above is ignored.
      // Inject the same fixtures via the test-only projectContext override.
      // `switchProject` is a fire-and-forget side effect dispatched into the
      // Redux store in production; the test asserts the button was wired to it
      // rather than re-simulating the slice + cache-reset chain.
      projectContext: { accessibleProjects: ACCESSIBLE_PROJECTS, switchProject },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));

    expect(await screen.findByText(PROJECT_SWITCHER_STRINGS.PANEL_TITLE)).toBeInTheDocument();

    const alphaOption = screen.getByRole("option", { name: "Alpha Project" });
    const betaOption = screen.getByRole("option", { name: "Beta Project" });
    expect(alphaOption).toHaveAttribute("aria-selected", "true");
    expect(alphaOption).toHaveClass("project-switcher-panel__item--selected");
    expect(betaOption).toHaveAttribute("aria-selected", "false");

    expect(screen.getByRole("button", { name: PROJECT_SWITCHER_STRINGS.MANAGE_PROJECTS_LABEL })).toBeInTheDocument();

    await user.type(screen.getByLabelText(PROJECT_SWITCHER_STRINGS.SEARCH_ARIA_LABEL), "Beta");
    expect(screen.queryByRole("option", { name: "Alpha Project" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beta Project" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "Beta Project" }));
    expect(screen.getByRole("option", { name: "Beta Project" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Beta Project" })).toHaveClass("project-switcher-panel__item--selected");
    await user.click(screen.getByRole("button", { name: PROJECT_SWITCHER_STRINGS.SWITCH_LABEL }));

    await waitFor(() => {
      expect(screen.queryByText(PROJECT_SWITCHER_STRINGS.PANEL_TITLE)).not.toBeInTheDocument();
    });
    expect(switchProject).toHaveBeenCalledWith("proj-beta");
  });

  it("[tag:project-switcher] manage projects navigates to project management route", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));
    await user.click(screen.getByRole("button", { name: PROJECT_SWITCHER_STRINGS.MANAGE_PROJECTS_LABEL }));

    expect(mockNavigate).toHaveBeenCalledWith("/projects");
  });

  it("[tag:project-switcher] shows loading spinner while projects are loading", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      projectContext: { loading: true, accessibleProjects: [] },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));

    expect(await screen.findByText(PROJECT_SWITCHER_STRINGS.PANEL_TITLE)).toBeInTheDocument();
    expect(document.querySelector(".project-switcher-panel__loading")).toBeInTheDocument();
  });

  it("[tag:project-switcher] shows error message when project loading fails", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      projectContext: { error: "Failed to load projects.", accessibleProjects: [] },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));

    expect(await screen.findByText("Failed to load projects.")).toBeInTheDocument();
  });

  it("[tag:project-switcher] shows empty and no-results states", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      projectContext: { accessibleProjects: [] },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));
    expect(await screen.findByText(PROJECT_SWITCHER_STRINGS.NO_PROJECTS)).toBeInTheDocument();
  });

  it("[tag:project-switcher] shows no-results message and clears search", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      projectContext: { accessibleProjects: ACCESSIBLE_PROJECTS },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));
    await user.type(screen.getByLabelText(PROJECT_SWITCHER_STRINGS.SEARCH_ARIA_LABEL), "zzz");
    expect(screen.getByText(PROJECT_SWITCHER_STRINGS.NO_RESULTS)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("option", { name: "Alpha Project" })).toBeInTheDocument();
  });

  it("[tag:project-switcher] cancel closes panel without switching project", async () => {
    const user = userEvent.setup();
    const switchProject = vi.fn();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      projectContext: { accessibleProjects: ACCESSIBLE_PROJECTS, switchProject },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));
    await user.click(screen.getByRole("option", { name: "Beta Project" }));
    await user.click(screen.getByRole("button", { name: PROJECT_SWITCHER_STRINGS.CANCEL_LABEL }));

    await waitFor(() => {
      expect(screen.queryByText(PROJECT_SWITCHER_STRINGS.PANEL_TITLE)).not.toBeInTheDocument();
    });
    expect(switchProject).not.toHaveBeenCalled();
  });

  it("[tag:project-switcher] keeps switch disabled when active project remains selected", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectSwitcher />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
        },
      },
      projectContext: { accessibleProjects: ACCESSIBLE_PROJECTS },
    });

    await user.click(screen.getByRole("button", { name: /Switch project/ }));

    expect(screen.getByRole("button", { name: PROJECT_SWITCHER_STRINGS.SWITCH_LABEL })).toBeDisabled();
  });

  it("[tag:project-switcher] shows unnamed project label when no active project is set", () => {
    renderWithProviders(<ProjectSwitcher />, {
      projectContext: { activeProject: null, accessibleProjects: ACCESSIBLE_PROJECTS },
    });

    expect(screen.getByText(PROJECT_SWITCHER_STRINGS.UNNAMED_PROJECT)).toBeInTheDocument();
  });
});
