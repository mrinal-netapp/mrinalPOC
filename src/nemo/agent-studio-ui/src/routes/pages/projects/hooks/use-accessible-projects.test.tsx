import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Provider } from "react-redux";
import type { ReactNode } from "react";

import { createMockStore } from "@test/mocks";
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock";
import { AuthContext } from "@/contexts/auth/model/context";
import type { AuthContextValue } from "@/contexts/auth/model/auth.types";

import { useAccessibleProjects } from "./use-accessible-projects";

const AUTH_CTX: AuthContextValue = {
  isAuthenticated: true,
  token: "token-with-sub",
  user: { id: "user-123" },
  roles: [],
  permissions: [],
  loading: false,
  error: null,
  logout: async () => {},
  checkAuth: async () => {},
  refreshToken: async () => null,
};

const ALL_PROJECTS = {
  projects: [
    {
      id: "proj-a",
      name: "Alpha",
      role: "admin",
      created_at: "2026-05-25T14:32:10.123Z",
      updated_at: "2026-05-25T14:32:10.123Z",
      metadata: {},
      home_dir: "s3://default-nemo/projects/proj-a",
    },
    {
      id: "proj-b",
      name: "Beta",
      role: null,
      created_at: "2026-05-25T14:32:10.123Z",
      updated_at: "2026-05-25T14:32:10.123Z",
      metadata: {},
      home_dir: "s3://default-nemo/projects/proj-b",
    },
  ],
};

function createWrapper(store: ReturnType<typeof createMockStore>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <Provider store={store}>
        <AuthContext.Provider value={AUTH_CTX}>{children}</AuthContext.Provider>
      </Provider>
    );
  };
}

describe("useAccessibleProjects", () => {
  beforeEach(() => {
    restoreAllMocks();
  });

  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:accessible-projects] skips project queries while auth is loading", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    mockFetchByUrl([
      { match: "/config/api/v1/projects", data: ALL_PROJECTS },
    ]);

    const loadingAuthCtx: AuthContextValue = {
      ...AUTH_CTX,
      loading: true,
      user: null,
      token: null,
    };

    const store = createMockStore();
    const { result } = renderHook(() => useAccessibleProjects(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Provider store={store}>
          <AuthContext.Provider value={loadingAuthCtx}>{children}</AuthContext.Provider>
        </Provider>
      ),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(true);
    });
    expect(result.current.isError).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("[tag:accessible-projects] returns only projects the user belongs to", async () => {
    mockFetchByUrl([
      { match: "/config/api/v1/projects", data: ALL_PROJECTS },
    ]);

    const store = createMockStore();
    const { result } = renderHook(() => useAccessibleProjects(), {
      wrapper: createWrapper(store),
    });

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
    });
    expect(result.current.projects[0]?.id).toBe("proj-a");
    expect(result.current.projects[0]?.roleLabel).toBe("Admin");
    expect(result.current.isProjectAdmin("proj-a")).toBe(true);
    expect(result.current.isProjectAdmin("proj-b")).toBe(false);
  });
});
