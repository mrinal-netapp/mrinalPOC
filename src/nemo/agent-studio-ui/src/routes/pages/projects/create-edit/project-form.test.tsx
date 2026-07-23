import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router";

import { renderWithProviders, userEvent } from "@test/render";
import { mockFetchByUrl, mockFetchSuccess, restoreAllMocks } from "@test/api-mock";
import { toast } from "@/ui-lib/base-components/toast/toast";
import type { Project } from "@/api/project.types";
import { projectsApi } from "@/api/project-api.slice";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import { PROJECT_ACCESS_STRINGS } from "./project-access.consts";
import { ProjectForm } from "./project-form";
import { ProjectEditPage } from "./project-edit-page";
import { ProjectCreateForm } from "./project-create-form";

/** Keep in sync with `PROJECT_CREATE_REFETCH_DELAY_MS` in
 *  `project-form.tsx`. Pinning the value lets the timer-based tests
 *  fail loudly if the constant moves without a deliberate update. */
const EXPECTED_CREATE_REFETCH_DELAY_MS = 3_000;

const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./project-form.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-form.utils")>();
  return {
    ...actual,
    waitForProjectMembershipReady: vi.fn().mockResolvedValue(false),
  };
});

import { waitForProjectMembershipReady } from "./project-form.utils";

const PROJECT: Project = {
  id: "projabc123",
  name: "Dev project",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Workspace" },
  home_dir: "s3://default-nemo/projects/projabc123",
};

describe("ProjectForm", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.mocked(toast.success).mockClear();
  });

  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:project-form] renders create form", () => {
    renderWithProviders(<ProjectForm />);
    expect(screen.getByRole("heading", { name: PROJECT_FORM_STRINGS.CREATE_TITLE })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL })).toBeInTheDocument();
  });

  it("[tag:project-form] renders edit form with initial values", () => {
    renderWithProviders(<ProjectForm isEdit initialData={PROJECT} />);

    expect(screen.getByRole("heading", { name: PROJECT_FORM_STRINGS.EDIT_TITLE })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.SAVE_LABEL })).toBeInTheDocument();
    expect(screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL)).toHaveValue("Dev project");
    expect(screen.getByLabelText(PROJECT_FORM_STRINGS.DESCRIPTION_LABEL)).toHaveValue("Workspace");
  });

  it("[tag:project-form] cancel navigates back to projects list", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectForm />);
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.CANCEL_LABEL }));

    expect(mockNavigate).toHaveBeenCalledWith("/projects");
  });

  it("[tag:project-form] shows error toast when update fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
      text: () => Promise.resolve(JSON.stringify({ error: "Server error" })),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this; },
    } as Response);

    renderWithProviders(<ProjectForm isEdit initialData={PROJECT} />);

    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("[tag:project-form] shows validation error when name is empty on submit", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ProjectForm />);
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL }));

    expect(await screen.findByText(PROJECT_FORM_STRINGS.NAME_REQUIRED)).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("[tag:project-form] updates project and navigates to list", async () => {
    const user = userEvent.setup();
    mockFetchSuccess({
      ...PROJECT,
      name: "Dev project updated",
      metadata: { description: "Updated workspace" },
    });

    renderWithProviders(<ProjectForm isEdit initialData={PROJECT} />);

    const nameInput = screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL);
    await user.clear(nameInput);
    await user.type(nameInput, "Dev project updated");
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        PROJECT_FORM_STRINGS.UPDATE_SUCCESS("Dev project updated"),
      );
    });
    expect(mockNavigate).toHaveBeenCalledWith("/projects");
  });

  async function selectAdminRole(user: ReturnType<typeof userEvent.setup>, container: HTMLElement): Promise<void> {
    const triggers = container.querySelectorAll<HTMLElement>('[data-slot="select-dropdown-trigger"]');
    const trigger = triggers[triggers.length - 1];
    if (!trigger) throw new Error("Role select trigger not found");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Admin" }));
  }

  it("[tag:project-form] saves edit immediately when adding an admin invite", async () => {
    const user = userEvent.setup();
    mockFetchByUrl([
      {
        match: `/projects/${PROJECT.id}/members`,
        data: {
          projectId: PROJECT.id,
          members: [{ userId: "user-123", email: "user-123@example.com", role: "admin" }],
        },
      },
      {
        match: `/projects/${PROJECT.id}`,
        data: PROJECT,
      },
    ]);

    const { container } = renderWithProviders(<ProjectForm isEdit initialData={PROJECT} />);

    await waitFor(() => {
      expect(screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`)).toHaveValue("user-123@example.com");
    });

    await user.click(screen.getByRole("button", { name: PROJECT_ACCESS_STRINGS.ADD_USER_LABEL }));
    await user.type(
      screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 2`),
      "newadmin@example.com",
    );
    await selectAdminRole(user, container);
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects");
    });
  });
});

describe("ProjectCreateForm", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:project-create-form] creates project and navigates to list", async () => {
    const user = userEvent.setup();
    mockFetchSuccess(PROJECT);

    renderWithProviders(<ProjectCreateForm />);

    await user.type(screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL), "Team A");
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(PROJECT_FORM_STRINGS.CREATE_SUCCESS("Team A"));
    });
    // Same router-navigate pattern as delete — RTK Query's
    // `ProjectList LIST` tag invalidation fans the refetch out to every
    // subscriber (list page + project switcher dropdown).
    expect(mockNavigate).toHaveBeenCalledWith("/projects");
  });

  it("[tag:project-create-form] schedules a delayed ProjectList re-invalidation after create", async () => {
    // Pin the timing-sensitive regression fix: the mutation's own
    // invalidation runs immediately on success, but the server-side
    // ProjectInitWorkflow (Bifrost VK / Keycloak SA / namespace) can
    // race that first refetch. The form schedules a SECOND
    // invalidation `PROJECT_CREATE_REFETCH_DELAY_MS` later. Verify
    // (a) the timer was set with the expected delay and (b) the
    // invalidation didn't dispatch until that timer fires.
    const user = userEvent.setup();
    mockFetchSuccess(PROJECT);

    // Capture the scheduled timer callback so we can fire it on demand
    // without using fake timers (which conflict with userEvent's own
    // microtask handling here).
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const invalidateSpy = vi.spyOn(projectsApi.util, "invalidateTags");

    renderWithProviders(<ProjectCreateForm />);

    await user.type(screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL), "Team A");
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(PROJECT_FORM_STRINGS.CREATE_SUCCESS("Team A"));
    });

    // (a) A timer was queued at exactly the documented delay.
    const matchingTimers = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => ms === EXPECTED_CREATE_REFETCH_DELAY_MS,
    );
    expect(matchingTimers).toHaveLength(1);

    // (b) The delayed invalidation hasn't dispatched yet.
    const matchedInvalidate = (): boolean =>
      invalidateSpy.mock.calls.some(([tags]) => {
        if (!Array.isArray(tags)) return false;
        return tags.some(
          (t) => typeof t === "object" && t !== null
            && (t as { type?: string }).type === "ProjectList"
            && (t as { id?: string }).id === "LIST",
        );
      });
    expect(matchedInvalidate()).toBe(false);

    // Fire the scheduled callback and verify the invalidation now ran.
    const [callback] = matchingTimers[0] as [() => void, number];
    callback();
    expect(matchedInvalidate()).toBe(true);

    setTimeoutSpy.mockRestore();
    invalidateSpy.mockRestore();
  });

  it("[tag:project-create-form] does NOT schedule the delayed re-invalidation on edit", async () => {
    // The delayed refetch is create-only — edit has no
    // ProjectInitWorkflow to race, so the immediate RTK invalidation
    // is sufficient. Guard against future drift where someone
    // refactors and accidentally schedules the timer in both branches.
    const user = userEvent.setup();
    mockFetchSuccess({
      ...PROJECT,
      name: "Dev project updated",
      metadata: { description: "Updated workspace" },
    });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    renderWithProviders(<ProjectForm isEdit initialData={PROJECT} />);

    const nameInput = screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL);
    await user.clear(nameInput);
    await user.type(nameInput, "Dev project updated");
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.SAVE_LABEL }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/projects");
    });

    // No timer scheduled at the project-create delay. (Other unrelated
    // timers — UI animations, debounced inputs — may exist; we only
    // assert the create-specific one was skipped.)
    const hasCreateDelayTimer = setTimeoutSpy.mock.calls.some(
      ([, ms]) => ms === EXPECTED_CREATE_REFETCH_DELAY_MS,
    );
    expect(hasCreateDelayTimer).toBe(false);

    setTimeoutSpy.mockRestore();
  });

  it("[tag:project-create-form] shows invite init timeout when membership is not ready", async () => {
    const user = userEvent.setup();
    mockFetchSuccess(PROJECT);
    vi.mocked(waitForProjectMembershipReady).mockResolvedValue(false);

    renderWithProviders(<ProjectCreateForm />);

    await user.type(screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL), "Team A");
    await user.click(screen.getByRole("button", { name: new RegExp(PROJECT_FORM_STRINGS.ACCESS_SECTION_TITLE) }));
    await user.type(
      screen.getByLabelText(`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} 1`),
      "invitee@example.com",
    );
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(PROJECT_ACCESS_STRINGS.INVITE_INIT_TIMEOUT);
      expect(toast.success).toHaveBeenCalledWith(PROJECT_FORM_STRINGS.CREATE_SUCCESS("Team A"));
    });
    expect(mockNavigate).toHaveBeenCalledWith("/projects");
  });

  it("[tag:project-create-form] shows error toast when create fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
      text: () => Promise.resolve(JSON.stringify({ error: "Server error" })),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this; },
    } as Response);

    renderWithProviders(<ProjectCreateForm />);

    await user.type(screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL), "Team A");
    await user.click(screen.getByRole("button", { name: PROJECT_FORM_STRINGS.ADD_LABEL }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(PROJECT_FORM_STRINGS.CREATE_ERROR);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe("ProjectEditPage", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:project-edit-page] redirects to projects list when projectId is missing", () => {
    renderWithProviders(
      <Routes>
        <Route path="/projects/edit" element={<ProjectEditPage />} />
        <Route path="/projects" element={<div>Projects list</div>} />
      </Routes>,
      { initialEntries: ["/projects/edit"] },
    );

    expect(screen.getByText("Projects list")).toBeInTheDocument();
  });

  it("[tag:project-edit-page] shows loading spinner while project loads", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));

    renderWithProviders(
      <Routes>
        <Route path="/projects/:projectId/edit" element={<ProjectEditPage />} />
      </Routes>,
      { initialEntries: ["/projects/projabc123/edit"] },
    );

    expect(document.querySelector(".project-form-page__loading")).toBeInTheDocument();
  });

  it("[tag:project-edit-page] shows load error when project query fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
      text: () => Promise.resolve(JSON.stringify({ error: "Server error" })),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this; },
    } as Response);

    renderWithProviders(
      <Routes>
        <Route path="/projects/:projectId/edit" element={<ProjectEditPage />} />
      </Routes>,
      { initialEntries: ["/projects/projabc123/edit"] },
    );

    await waitFor(() => {
      expect(screen.getByText(PROJECT_FORM_STRINGS.LOAD_ERROR)).toBeInTheDocument();
    });
  });

  it("[tag:project-edit-page] loads project and renders edit form", async () => {
    mockFetchSuccess(PROJECT);

    renderWithProviders(
      <Routes>
        <Route path="/projects/:projectId/edit" element={<ProjectEditPage />} />
      </Routes>,
      { initialEntries: ["/projects/projabc123/edit"] },
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: PROJECT_FORM_STRINGS.EDIT_TITLE })).toBeInTheDocument();
    });
    expect(screen.getByLabelText(PROJECT_FORM_STRINGS.NAME_LABEL)).toHaveValue("Dev project");
  });
});
