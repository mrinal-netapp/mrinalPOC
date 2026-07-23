import { afterEach, describe, expect, it, vi } from "vitest";

async function loadFlagsModule() {
  return import("./feature-flags");
}

describe("feature-flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("[tag:feature-flags] defaults both flags to false when env vars are missing", async () => {
    vi.stubEnv("VITE_FEATURE_AGENT_CONFIGURATIONS_TAB", "");
    vi.stubEnv("VITE_FEATURE_AGENT_METRICS_ROW", "");

    const flags = await loadFlagsModule();
    expect(flags.FEATURE_AGENT_CONFIGURATIONS_TAB).toBe(false);
    expect(flags.FEATURE_AGENT_METRICS_ROW).toBe(false);
  });

  it("[tag:feature-flags] parses true-ish and false-ish values", async () => {
    vi.stubEnv("VITE_FEATURE_AGENT_CONFIGURATIONS_TAB", "1");
    vi.stubEnv("VITE_FEATURE_AGENT_METRICS_ROW", "false");

    const flags = await loadFlagsModule();
    expect(flags.FEATURE_AGENT_CONFIGURATIONS_TAB).toBe(true);
    expect(flags.FEATURE_AGENT_METRICS_ROW).toBe(false);
  });

  it("[tag:feature-flags] falls back to false for invalid values", async () => {
    vi.stubEnv("VITE_FEATURE_AGENT_CONFIGURATIONS_TAB", "maybe");
    vi.stubEnv("VITE_FEATURE_AGENT_METRICS_ROW", "??");

    const flags = await loadFlagsModule();
    expect(flags.FEATURE_AGENT_CONFIGURATIONS_TAB).toBe(false);
    expect(flags.FEATURE_AGENT_METRICS_ROW).toBe(false);
  });
});
