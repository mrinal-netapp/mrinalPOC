import { type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";
import { useProjectRolesMap } from "./use-project-roles-map";

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("./use-accessible-projects", () => ({
  useAccessibleProjects: vi.fn(),
}));

import { useAuth } from "@/contexts/auth/hooks/useAuth";
import { useAccessibleProjects } from "./use-accessible-projects";

function renderRolesHook(projectIds: string[]) {
  const store = createMockStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  return renderHook(() => useProjectRolesMap(projectIds), { wrapper });
}

describe("useProjectRolesMap", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "user-123" },
      loading: false,
    } as ReturnType<typeof useAuth>);
    vi.mocked(useAccessibleProjects).mockReturnValue({
      roleByProjectId: {
        "proj-alpha": "admin",
        "proj-beta": "member",
      },
    } as unknown as ReturnType<typeof useAccessibleProjects>);
  });

  it("[tag:use-project-roles-map] returns empty map for no project ids", () => {
    expect(renderRolesHook([]).result.current).toEqual({});
  });

  it("[tag:use-project-roles-map] returns placeholders while auth is loading", () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      loading: true,
    } as ReturnType<typeof useAuth>);

    expect(renderRolesHook(["proj-alpha", "proj-beta"]).result.current).toEqual({
      "proj-alpha": "—",
      "proj-beta": "—",
    });
  });

  it("[tag:use-project-roles-map] maps project ids to formatted role labels", () => {
    expect(renderRolesHook(["proj-alpha", "proj-beta"]).result.current).toEqual({
      "proj-alpha": "Admin",
      "proj-beta": "Member",
    });
  });
});
