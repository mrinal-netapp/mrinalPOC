import { Outlet } from "react-router";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/contexts/auth/guards/AppAuthGate", () => ({
  AppAuthGate: () => <Outlet />,
}));

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: false,
    token: null,
    user: { id: "test-user" },
    roles: [],
    permissions: [],
    loading: false,
    error: null,
    logout: async () => {},
    checkAuth: async () => {},
    refreshToken: async () => null,
  })),
}));

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import { mockFetchByUrl, mockFetchError, restoreAllMocks } from "@test/api-mock";
import { routes } from "@/routes/routes";
import type { Project } from "@/api/project.types";
import {
  PROJECTS_LIST_STRINGS,
} from "../projects.consts";
import { PROJECT_FORM_STRINGS } from "../create-edit/project-form.consts";
import { ProjectsListPage } from "./projects-list-page";
import { ProjectsListContent } from "./projects-list-content";

const PROJECT: Project = {
  id: "projk3m9x2ab",
  name: "Marketing Analytics",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Team workspace" },
  home_dir: "s3://default-nemo/projects/projk3m9x2ab",
};

function mockAccessibleProjectsFetch(projects = [PROJECT]): void {
  // `useAccessibleProjects` is caller-scoped: it hits /projects only and
  // expects the `role` field embedded on each row. Projects without a role
  // are filtered out, so include role: "admin" on each fixture.
  mockFetchByUrl([
    {
      match: "/projects",
      data: { projects: projects.map((p) => ({ ...p, role: "admin" })) },
    },
  ]);
}

describe("ProjectsListPage", () => {
  it("[tag:projects-list-page] renders page title", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ projects: [] }),
      text: () => Promise.resolve(JSON.stringify({ projects: [] })),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this; },
    } as Response);

    renderWithProviders(<ProjectsListPage />);

    expect(screen.getByRole("heading", { name: PROJECTS_LIST_STRINGS.PAGE_TITLE })).toBeInTheDocument();
  });
});

describe("ProjectsListContent", () => {
  let resizeObserver: ReturnType<typeof mockResizeObserver>;

  beforeEach(() => {
    resizeObserver = mockResizeObserver();
  });

  afterEach(() => {
    resizeObserver.cleanup();
    restoreAllMocks();
  });

  it("[tag:projects-list-content] renders project rows from API", async () => {
    mockAccessibleProjectsFetch();

    renderWithProviders(<ProjectsListContent />);

    await waitFor(() => {
      expect(screen.getByText("Marketing Analytics")).toBeInTheDocument();
    });
    expect(screen.getByText("Team workspace")).toBeInTheDocument();
  });

  it("[tag:projects-list-content] renders empty state when API returns no projects", async () => {
    mockAccessibleProjectsFetch([]);

    renderWithProviders(<ProjectsListContent />);

    await waitFor(() => {
      expect(screen.getByText(PROJECTS_LIST_STRINGS.EMPTY_STATE_WELCOME)).toBeInTheDocument();
    });
  });

  it("[tag:projects-list-content] renders error state when API fails", async () => {
    mockFetchError(500, { error: "Server error" });

    renderWithProviders(<ProjectsListContent />);

    await waitFor(() => {
      expect(screen.getByText("An error has occurred")).toBeInTheDocument();
    });
  });
});

describe("Projects routes", () => {
  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:projects-layout][tag:router] renders management sidebar and list page at /projects", async () => {
    mockAccessibleProjectsFetch();

    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: ["/projects"],
    });

    expect(screen.getByTestId("projects-layout")).toBeInTheDocument();
    expect(screen.getByTestId("projects-management-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("service-context-tabs")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Management" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Agent Studio" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: PROJECTS_LIST_STRINGS.PAGE_TITLE })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Marketing Analytics")).toBeInTheDocument();
    });
  });

  it("[tag:projects-layout][tag:router] shows service context tabs on /projects", () => {
    mockAccessibleProjectsFetch([]);

    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: ["/projects"],
    });

    expect(screen.getByRole("tab", { name: "Agent Studio" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Management" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Projects" })).toBeInTheDocument();
  });

  it("[tag:projects-layout][tag:router] navigates to Agent Studio from projects screen", async () => {
    mockAccessibleProjectsFetch([]);
    const user = userEvent.setup();

    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: ["/projects"],
    });

    await user.click(screen.getByRole("tab", { name: "Agent Studio" }));

    expect(screen.getByRole("tab", { name: "Agent Studio" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("projects-layout")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-main-content")).toHaveTextContent("Agent Studio: build AI on your data");
  });

  it("[tag:projects-layout][tag:router] renders edit page at /projects/:projectId/edit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const rawUrl = typeof input === "string" ? input : input.toString();
      const pathname = new URL(rawUrl, "http://localhost").pathname;
      const body = /\/projects\/[^/]+$/.test(pathname) ? PROJECT : { projects: [PROJECT] };

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
        headers: new Headers({ "content-type": "application/json" }),
        clone: function () { return this; },
      } as Response);
    });

    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: ["/projects/projk3m9x2ab/edit"],
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: PROJECT_FORM_STRINGS.EDIT_TITLE })).toBeInTheDocument();
    });
  });
});
