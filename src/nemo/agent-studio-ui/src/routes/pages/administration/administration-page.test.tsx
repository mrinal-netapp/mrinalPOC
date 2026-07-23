import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Outlet, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";

vi.mock("@/contexts/auth/guards/AppAuthGate", () => ({
  AppAuthGate: () => <Outlet />,
}));

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: false,
    token: null,
    user: null,
    roles: [],
    permissions: [],
    loading: false,
    error: null,
    logout: async () => {},
    checkAuth: async () => {},
    refreshToken: async () => null,
  })),
}));

import { renderWithProviders } from "@test/render";
import { restoreAllMocks } from "@test/api-mock";
import { AuthContext } from "@/contexts/auth/model/context";
import type { AuthContextValue } from "@/contexts/auth/model/auth.types";
import type { Project } from "@/api/project.types";
import type { RootState } from "@/store/store.types";
import { routes } from "@/routes/routes";
import { ADMINISTRATION_STRINGS } from "./administration.consts";
import { ADMINISTRATION_MEMBERS_STRINGS } from "./administration-members.consts";
import { PROJECTS_LIST_STRINGS } from "../projects/projects.consts";
import { AdministrationPage } from "./administration-page";
import { ProjectsListPage } from "../projects/list/projects-list-page";

const ACTIVE_PROJECT: Project = {
  id: "projk3m9x2ab",
  name: "Marketing Analytics",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Campaign performance and attribution workspace." },
  home_dir: "s3://default-nemo/projects/projk3m9x2ab",
};

const MEMBERS_RESPONSE = {
  projectId: ACTIVE_PROJECT.id,
  members: [
    {
      userId: "al@example.com",
      role: "admin",
    },
    {
      userId: "ben@example.com",
      role: "member",
    },
  ],
};

const BASE_AUTH_CTX: AuthContextValue = {
  isAuthenticated: true,
  token: "token",
  user: { id: "user-123" },
  roles: ["user"],
  permissions: [],
  loading: false,
  error: null,
  logout: async () => {},
  checkAuth: async () => {},
  refreshToken: async () => null,
};

function renderWithAuth(
  ui: ReactElement,
  authOverrides: Partial<AuthContextValue> = {},
  options?: { initialEntries?: string[]; preloadedState?: Partial<RootState> },
): ReturnType<typeof renderWithProviders> {
  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <AuthContext.Provider value={{ ...BASE_AUTH_CTX, ...authOverrides }}>
        {children}
      </AuthContext.Provider>
    );
  }

  return renderWithProviders(<Wrapper>{ui}</Wrapper>, options);
}

function getFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

function mockProjectAndMembersFetch(): void {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = getFetchUrl(input);
    const data = url.includes("/members") ? MEMBERS_RESPONSE : ACTIVE_PROJECT;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
      headers: new Headers({ "content-type": "application/json" }),
      clone: function () { return this; },
    });
  });
  vi.stubGlobal("fetch", mock);
}

describe("AdministrationPage", () => {
  beforeEach(() => {
    mockProjectAndMembersFetch();
  });

  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:administration-page] renders page title and overview tab content", async () => {
    renderWithAuth(<AdministrationPage />, {}, {
      preloadedState: {
        projectContext: {
          activeProject: { id: ACTIVE_PROJECT.id, name: ACTIVE_PROJECT.name, role: "admin" },
        },
      },
    });

    expect(screen.getByRole("heading", { name: ADMINISTRATION_STRINGS.PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Members (2)" })).toBeInTheDocument();
      expect(screen.getByText(ACTIVE_PROJECT.name)).toBeInTheDocument();
      expect(screen.getByText("Campaign performance and attribution workspace.")).toBeInTheDocument();
    });
    expect(screen.getByText(ADMINISTRATION_STRINGS.PROJECTS_SECTION_LABEL)).toBeInTheDocument();
  });

  it("[tag:administration-page] shows members tab content when Members tab is selected", async () => {
    const user = userEvent.setup();
    renderWithAuth(<AdministrationPage />, {}, {
      preloadedState: {
        projectContext: {
          activeProject: { id: ACTIVE_PROJECT.id, name: ACTIVE_PROJECT.name, role: "admin" },
        },
      },
    });

    await user.click(screen.getByRole("tab", { name: "Members" }));

    await waitFor(() => {
      expect(screen.getByText(ADMINISTRATION_MEMBERS_STRINGS.SUMMARY_TOTAL)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: ADMINISTRATION_MEMBERS_STRINGS.ADD_MEMBER_LABEL })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Members (2)" })).toBeInTheDocument();
    });
  });

  it("[tag:administration-page] enables Manage projects for all users", () => {
    renderWithAuth(<AdministrationPage />, { roles: ["user"] });

    expect(
      screen.getByRole("button", { name: ADMINISTRATION_STRINGS.MANAGE_PROJECTS_LABEL }),
    ).not.toBeDisabled();
  });

  it("[tag:administration-page][tag:routes] navigates to projects when Manage projects is clicked", async () => {
    const user = userEvent.setup();

    renderWithAuth(
      <Routes>
        <Route path="/administration" element={<AdministrationPage />} />
        <Route path="/projects" element={<ProjectsListPage />} />
      </Routes>,
      { roles: ["user"] },
      { initialEntries: ["/administration"] },
    );

    await user.click(
      screen.getByRole("button", { name: ADMINISTRATION_STRINGS.MANAGE_PROJECTS_LABEL }),
    );

    expect(screen.getByRole("heading", { name: PROJECTS_LIST_STRINGS.PAGE_TITLE })).toBeInTheDocument();
  });
});

describe("Administration routes", () => {
  it("[tag:administration-page][tag:router] renders administration page at /administration", () => {
    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: ["/administration"],
    });

    expect(screen.getByRole("heading", { name: ADMINISTRATION_STRINGS.PAGE_TITLE })).toBeInTheDocument();
  });

  it("[tag:projects-stub][tag:router] renders projects list shell at /projects", () => {
    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: ["/projects"],
    });

    expect(screen.getByRole("heading", { name: PROJECTS_LIST_STRINGS.PAGE_TITLE })).toBeInTheDocument();
  });
});
