import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { refreshProvidersMock, toastSuccess, toastError } = vi.hoisted(() => ({
  refreshProvidersMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/routes/pages/models/models.api", () => ({
  useRefreshProvidersMutation: () => [refreshProvidersMock, { isLoading: false }],
}));

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

import { useRefreshProviderHealth } from "./use-refresh-provider-health";

/** Resolves once the microtask queue (unwrap().then/.catch) has drained. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useRefreshProviderHealth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("[tag:refresh-health] pluralises the success toast for multiple providers", async () => {
    refreshProvidersMock.mockReturnValue({
      unwrap: () => Promise.resolve({ data: [{}, {}] }),
    });

    const { result } = renderHook(() => useRefreshProviderHealth());
    act(() => result.current.refresh("proj-1"));
    await flush();

    expect(refreshProvidersMock).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(toastSuccess).toHaveBeenCalledWith(
      "Connection health refreshed for 2 providers.",
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("[tag:refresh-health] uses the singular form for exactly one provider", async () => {
    refreshProvidersMock.mockReturnValue({
      unwrap: () => Promise.resolve({ data: [{}] }),
    });

    const { result } = renderHook(() => useRefreshProviderHealth());
    act(() => result.current.refresh("proj-1"));
    await flush();

    expect(toastSuccess).toHaveBeenCalledWith(
      "Connection health refreshed for 1 provider.",
    );
  });

  it("[tag:refresh-health] falls back to the generic message when no providers are returned", async () => {
    refreshProvidersMock.mockReturnValue({
      unwrap: () => Promise.resolve({}),
    });

    const { result } = renderHook(() => useRefreshProviderHealth());
    act(() => result.current.refresh("proj-1"));
    await flush();

    expect(toastSuccess).toHaveBeenCalledWith("Connection health refreshed.");
  });

  it("[tag:refresh-health] surfaces an error toast when the refresh fails", async () => {
    refreshProvidersMock.mockReturnValue({
      unwrap: () => Promise.reject(new Error("boom")),
    });

    const { result } = renderHook(() => useRefreshProviderHealth());
    act(() => result.current.refresh("proj-1"));
    await flush();

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't refresh connection health. Please try again.",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("[tag:refresh-health] exposes the in-flight flag from the mutation", () => {
    const { result } = renderHook(() => useRefreshProviderHealth());
    expect(result.current.isRefreshing).toBe(false);
  });
});
