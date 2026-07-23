import { describe, expect, it } from "vitest";
import { getToolsetStatusVisual } from "./toolsets-panel.utils";

describe("getToolsetStatusVisual", () => {
  it("[tag:agents] returns icon config for Healthy status", () => {
    const visual = getToolsetStatusVisual("Healthy");
    expect(visual.type).toBe("icon");
    expect(visual.color).toBe("var(--notification-success)");
    expect(visual.Icon).toBeDefined();
  });

  it("[tag:agents] returns icon config for Unhealthy status", () => {
    const visual = getToolsetStatusVisual("Unhealthy");
    expect(visual.type).toBe("icon");
    expect(visual.color).toBe("var(--notification-error)");
    expect(visual.Icon).toBeDefined();
  });
});
