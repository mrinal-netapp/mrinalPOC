import { describe, expect, it } from "vitest";
import { getKbStatusVisual } from "./assigned-kb-panel.utils";

describe("getKbStatusVisual", () => {
  it("[tag:agents] returns icon config for Available status", () => {
    const visual = getKbStatusVisual("Available");
    expect(visual.type).toBe("icon");
    expect(visual.color).toBe("var(--notification-success)");
    expect(visual.Icon).toBeDefined();
  });

  it("[tag:agents] returns spinner config for Synchronizing status", () => {
    const visual = getKbStatusVisual("Synchronizing");
    expect(visual.type).toBe("spinner");
    expect(visual.color).toBe("var(--notification-information)");
  });

  it("[tag:agents] returns error icon config for Errored status", () => {
    const visual = getKbStatusVisual("Errored");
    expect(visual.type).toBe("icon");
    expect(visual.color).toBe("var(--notification-error)");
    expect(visual.Icon).toBeDefined();
  });

  it("[tag:agents] returns muted icon config for Deprecated status", () => {
    const visual = getKbStatusVisual("Deprecated");
    expect(visual.type).toBe("icon");
    expect(visual.color).toBe("var(--text-disabled)");
    expect(visual.Icon).toBeDefined();
  });
});
