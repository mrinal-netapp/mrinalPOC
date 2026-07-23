import { type ReactElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";

import { createMockStore } from "@test/mocks";
import type { AccessibleProject } from "@/routes/pages/projects/hooks/use-accessible-projects";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import type { RootState } from "@/store/store.types";
import { useProject } from "../hooks/useProject";
import { ProjectProvider } from "./ProjectProvider";

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
    isProjectAdmin: (projectId: string) => projectId === "proj-alpha",
    isLoading: false,
    isError: false,
    ...overrides,
  });
}

function ProjectProbe(): ReactElement {
  const {
    activeProject,
    accessibleProjects,
    hasActiveProject,
    isAdmin,
    isMember,
    isViewer,
    hasAnyRole,
    loading,
    error,
    switchProject,
    clearProject,
  } = useProject();

  return (
    <div>
      <div data-testid="active-name">{activeProject?.name ?? "none"}</div>
      <div data-testid="active-role">{activeProject?.role ?? "none"}</div>
      <div data-testid="project-count">{accessibleProjects.length}</div>
      <div data-testid="has-active">{String(hasActiveProject)}</div>
      <div data-testid="is-admin">{String(isAdmin)}</div>
      <div data-testid="is-member">{String(isMember)}</div>
      <div data-testid="is-viewer">{String(isViewer)}</div>
      <div data-testid="has-any-role">{String(hasAnyRole(["admin", "member"]))}</div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="error">{error ?? "none"}</div>
      <button type="button" onClick={() => switchProject("proj-beta")}>switch-beta</button>
      <button type="button" onClick={() => switchProject("proj-alpha")}>switch-same</button>
      <button type="button" onClick={() => switchProject("")}>switch-empty</button>
      <button type="button" onClick={() => clearProject()}>clear</button>
    </div>
  );
}

function renderProvider(preloadedState?: Partial<RootState>) {
  const store = createMockStore(preloadedState);
  const view = render(
    <Provider store={store}>
      <MemoryRouter>
        <ProjectProvider>
          <ProjectProbe />
        </ProjectProvider>
      </MemoryRouter>
    </Provider>,
  );

  return { ...view, store };
}

describe("ProjectProvider", () => {
  beforeEach(() => {
    setupAccessibleProjects();
  });

  it("[tag:project-provider] exposes active project, accessible projects, and role flags", () => {
    renderProvider({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
      },
    });

    expect(screen.getByTestId("active-name")).toHaveTextContent("Alpha Project");
    expect(screen.getByTestId("active-role")).toHaveTextContent("admin");
    expect(screen.getByTestId("project-count")).toHaveTextContent("2");
    expect(screen.getByTestId("has-active")).toHaveTextContent("true");
    expect(screen.getByTestId("is-admin")).toHaveTextContent("true");
    expect(screen.getByTestId("is-member")).toHaveTextContent("false");
    expect(screen.getByTestId("is-viewer")).toHaveTextContent("false");
    expect(screen.getByTestId("has-any-role")).toHaveTextContent("true");
  });

  it("[tag:project-provider] backfills missing project name from accessible projects", async () => {
    const { store } = renderProvider({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "", role: "admin" },
      },
    });

    await waitFor(() => {
      expect(projectContextSelector.activeProjectName(store.getState())).toBe("Alpha Project");
    });
  });

  it("[tag:project-provider] exposes loading and error states from accessible projects hook", () => {
    setupAccessibleProjects({ isLoading: true, isError: true, projects: [] });

    renderProvider({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
      },
    });

    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    expect(screen.getByTestId("error")).toHaveTextContent("Failed to load projects.");
  });

  it("[tag:project-provider] switches active project and ignores no-op switches", async () => {
    const user = userEvent.setup();
    const { store } = renderProvider({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
      },
    });

    await user.click(screen.getByRole("button", { name: "switch-same" }));
    expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-alpha");

    await user.click(screen.getByRole("button", { name: "switch-beta" }));

    await waitFor(() => {
      expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-beta");
      expect(projectContextSelector.activeProjectName(store.getState())).toBe("Beta Project");
      expect(projectContextSelector.activeProjectRole(store.getState())).toBe("member");
    });

    await user.click(screen.getByRole("button", { name: "switch-empty" }));
    expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-beta");
  });

  it("[tag:project-provider] clearing active project auto-defaults to the first accessible one", async () => {
    // clearProject() intentionally leaves the slice empty for one tick,
    // but the reconciliation useEffect re-enters and picks the first
    // accessible project (Case 0). The observable end state is
    // "first-project active", not "no active project" -- this is the
    // "make first project default when none is set" behavior.
    const user = userEvent.setup();
    const { store } = renderProvider({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha Project", role: "admin" },
      },
    });

    await user.click(screen.getByRole("button", { name: "clear" }));

    await waitFor(() => {
      expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-alpha");
      expect(projectContextSelector.activeProjectRole(store.getState())).toBe("admin");
    });
    expect(screen.getByTestId("has-active")).toHaveTextContent("true");
  });

  it("[tag:project-provider] falls back to first accessible project when the persisted active id is no longer in the list", async () => {
    // Persisted state points at a project the caller no longer has --
    // simulate a delete-from-another-session: localStorage still
    // remembers proj-gamma, but the /projects response only lists
    // alpha & beta. Provider clears the stale id AND re-enters Case 0
    // on the next tick, defaulting to the first still-accessible
    // project so the user never lands in the "no active project" limbo.
    const { store } = renderProvider({
      projectContext: {
        activeProject: { id: "proj-gamma", name: "Gamma", role: "admin" },
      },
    });

    await waitFor(() => {
      expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-alpha");
      expect(projectContextSelector.activeProjectName(store.getState())).toBe("Alpha Project");
      expect(projectContextSelector.activeProjectRole(store.getState())).toBe("admin");
    });
    expect(screen.getByTestId("has-active")).toHaveTextContent("true");
  });

  it("[tag:project-provider] auto-defaults to first accessible project when there is no persisted active id", async () => {
    // Fresh login / cleared session: nothing in the slice, /projects
    // returns two entries. Provider should default to projects[0]
    // (proj-alpha) so the user isn't stuck on the "Unnamed project"
    // fallback with every project-scoped route gated off.
    const { store } = renderProvider();

    await waitFor(() => {
      expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-alpha");
      expect(projectContextSelector.activeProjectName(store.getState())).toBe("Alpha Project");
      expect(projectContextSelector.activeProjectRole(store.getState())).toBe("admin");
    });
    expect(screen.getByTestId("has-active")).toHaveTextContent("true");
  });

  it("[tag:project-provider] leaves state empty when there are no accessible projects to default to", async () => {
    // Empty accessible list AND no persisted active id -- the auto-
    // default has nothing to pick, so the "no active project" empty
    // state must surface for the projects-empty-state / create-first-
    // project flow to take over. Regression guard for a null crash if
    // projects[0] is undefined.
    setupAccessibleProjects({ projects: [], roleByProjectId: {} });
    const { store } = renderProvider();

    await waitFor(() => {
      expect(projectContextSelector.activeProjectId(store.getState())).toBe("");
    });
    expect(screen.getByTestId("has-active")).toHaveTextContent("false");
  });

  it("[tag:project-provider] does NOT clear active project while projects are still loading", async () => {
    // Mirror the first-render window: query hasn't returned yet, but
    // the persisted state already has a project from localStorage. The
    // provider must wait for the list to settle before deciding the
    // project is gone — otherwise the user gets logged out of their
    // project on every page refresh until the network call returns.
    setupAccessibleProjects({ projects: [], isLoading: true });
    const { store } = renderProvider({
      projectContext: {
        activeProject: { id: "proj-gamma", name: "Gamma", role: "admin" },
      },
    });

    // Active project survives the loading window untouched.
    expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-gamma");
    expect(projectContextSelector.activeProjectRole(store.getState())).toBe("admin");
  });

  it("[tag:project-provider] does NOT clear active project when /projects errors (transient outage)", async () => {
    // A failed /projects fetch shouldn't wipe persisted state — that
    // would log the user out of their project on every flaky reload.
    setupAccessibleProjects({ projects: [], isError: true });
    const { store } = renderProvider({
      projectContext: {
        activeProject: { id: "proj-gamma", name: "Gamma", role: "admin" },
      },
    });

    expect(projectContextSelector.activeProjectId(store.getState())).toBe("proj-gamma");
    expect(projectContextSelector.activeProjectRole(store.getState())).toBe("admin");
  });
});
