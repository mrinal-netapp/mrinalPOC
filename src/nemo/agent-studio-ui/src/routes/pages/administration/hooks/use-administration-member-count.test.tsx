import { type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Provider } from "react-redux";

import { createMockStore } from "@test/mocks";
import { useAdministrationMemberCount } from "./use-administration-member-count";

vi.mock("@/api/project-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/project-api.slice")>();
  return {
    ...actual,
    useListProjectMembersQuery: vi.fn(),
  };
});

import { useListProjectMembersQuery } from "@/api/project-api.slice";

function renderCountHook(preloadedState?: Parameters<typeof createMockStore>[0]) {
  const store = createMockStore(preloadedState);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  return renderHook(() => useAdministrationMemberCount(), { wrapper });
}

describe("useAdministrationMemberCount", () => {
  beforeEach(() => {
    vi.mocked(useListProjectMembersQuery).mockReturnValue({
      data: { projectId: "proj-alpha", members: [{ userId: "a@example.com", role: "admin" }] },
      isLoading: false,
      isError: false,
      error: undefined,
    } as unknown as ReturnType<typeof useListProjectMembersQuery>);
  });

  it("[tag:use-administration-member-count] returns null when no active project is selected", () => {
    expect(renderCountHook().result.current).toBeNull();
  });

  it("[tag:use-administration-member-count] returns member count for active project", () => {
    const { result } = renderCountHook({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha", role: "admin" },
      },
    });

    expect(result.current).toBe(1);
  });

  it("[tag:use-administration-member-count] returns null while members are loading", () => {
    vi.mocked(useListProjectMembersQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: undefined,
    } as unknown as ReturnType<typeof useListProjectMembersQuery>);

    const { result } = renderCountHook({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha", role: "admin" },
      },
    });

    expect(result.current).toBeNull();
  });

  it("[tag:use-administration-member-count] returns null when members query fails", () => {
    vi.mocked(useListProjectMembersQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500 },
    } as unknown as ReturnType<typeof useListProjectMembersQuery>);

    const { result } = renderCountHook({
      projectContext: {
        activeProject: { id: "proj-alpha", name: "Alpha", role: "admin" },
      },
    });

    expect(result.current).toBeNull();
  });
});
