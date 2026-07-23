import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAppBasePath() {
  vi.resetModules();
  return import("./app-base-path");
}

describe("app base path helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an empty app base path and undefined router basename at the host root", async () => {
    vi.stubEnv("VITE_BASE_PATH", "");

    const { getAppBasePath, getRouterBasename } = await loadAppBasePath();

    expect(getAppBasePath()).toBe("");
    expect(getRouterBasename()).toBeUndefined();
  });

  it("removes a trailing slash from the app base path", async () => {
    vi.stubEnv("VITE_BASE_PATH", "/app/");

    const { getAppBasePath } = await loadAppBasePath();

    expect(getAppBasePath()).toBe("/app");
  });

  it("keeps an app base path without a trailing slash", async () => {
    vi.stubEnv("VITE_BASE_PATH", "/app");

    const { getAppBasePath } = await loadAppBasePath();

    expect(getAppBasePath()).toBe("/app");
  });

  it("uses the app base path as the router basename", async () => {
    vi.stubEnv("VITE_BASE_PATH", "/studio");

    const { getRouterBasename } = await loadAppBasePath();

    expect(getRouterBasename()).toBe("/studio");
  });

  it("builds the overview URL from the current origin and app base path", async () => {
    vi.stubEnv("VITE_BASE_PATH", "/studio");

    const { getOverviewUrl } = await loadAppBasePath();

    expect(getOverviewUrl()).toBe(`${window.location.origin}/studio/overview`);
  });
});
