import { type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";
import { useIsProjectAdmin } from "./use-is-project-admin";

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("@/api/project-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/project-api.slice")>();
  return {
    ...actual,
    useListProjectsQuery: vi.fn(),
  };
});

import { useAuth } from "@/contexts/auth/hooks/useAuth";
import { useListProjectsQuery } from "@/api/project-api.slice";

function renderAdminHook(projectId?: string, useStubData = false) {
  const store = createMockStore();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  return renderHook(() => useIsProjectAdmin(projectId, useStubData), { wrapper });
}

describe("useIsProjectAdmin", () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
    } as ReturnType<typeof useAuth>);
    vi.mocked(useListProjectsQuery).mockReturnValue({
      data: { projects: [] },
    } as unknown as ReturnType<typeof useListProjectsQuery>);
  });

  it("[tag:use-is-project-admin] returns true for stub preview mode", () => {
    const { result } = renderAdminHook("proj-alpha", true);
    expect(result.current).toBe(true);
  });

  it("[tag:use-is-project-admin] returns false when projectId is missing or auth is loading", () => {
    expect(renderAdminHook(undefined).result.current).toBe(false);

    vi.mocked(useAuth).mockReturnValue({ loading: true } as ReturnType<typeof useAuth>);
    expect(renderAdminHook("proj-alpha").result.current).toBe(false);
  });

  it("[tag:use-is-project-admin] returns true only when caller-scoped project role is admin", () => {
    vi.mocked(useListProjectsQuery).mockReturnValue({
      data: {
        projects: [
          { id: "proj-alpha", name: "Alpha", role: "admin" },
          { id: "proj-beta", name: "Beta", role: "member" },
        ],
      },
    } as unknown as ReturnType<typeof useListProjectsQuery>);

    expect(renderAdminHook("proj-alpha").result.current).toBe(true);
    expect(renderAdminHook("proj-beta").result.current).toBe(false);
    expect(renderAdminHook("proj-missing").result.current).toBe(false);
  });
});
