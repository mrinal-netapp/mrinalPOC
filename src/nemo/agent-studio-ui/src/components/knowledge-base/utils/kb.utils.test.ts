import { describe, it, expect } from "vitest";
import {
  IconCircleCheck,
  IconCircleX,
  IconCircleMinus,
  IconClock,
  IconLoader,
} from "@tabler/icons-react";

import type { KBStatus, KBSnapshotBuildStatus } from "@/api/kb.types";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import {
  KB_STATUS_ICON_MAP,
  KB_SNAPSHOT_STATUS_MAP,
  getKBStatusVisual,
  getKBStatusLabel,
  formatKBIndexedData,
  kbStatusPollingInterval,
  kbListPollingInterval,
} from "./kb.utils";

// ---------------------------------------------------------------------------
// KB_STATUS_ICON_MAP completeness
// ---------------------------------------------------------------------------

describe("KB_STATUS_ICON_MAP", () => {
  const ALL_STATUSES: KBStatus[] = ["in_progress", "ready", "errored", "deprecated"];

  it("[tag:kb][tag:utils] has an entry for every KBStatus", () => {
    for (const s of ALL_STATUSES) {
      expect(KB_STATUS_ICON_MAP[s]).toBeDefined();
    }
  });

  it("[tag:kb][tag:utils] maps in_progress to spinner type", () => {
    expect(KB_STATUS_ICON_MAP.in_progress.type).toBe("spinner");
  });

  it("[tag:kb][tag:utils] maps ready to IconCircleCheck", () => {
    expect(KB_STATUS_ICON_MAP.ready.Icon).toBe(IconCircleCheck);
  });

  it("[tag:kb][tag:utils] maps errored to IconCircleX", () => {
    expect(KB_STATUS_ICON_MAP.errored.Icon).toBe(IconCircleX);
  });

  it("[tag:kb][tag:utils] maps deprecated to IconCircleMinus", () => {
    expect(KB_STATUS_ICON_MAP.deprecated.Icon).toBe(IconCircleMinus);
  });
});

// ---------------------------------------------------------------------------
// KB_SNAPSHOT_STATUS_MAP completeness
// ---------------------------------------------------------------------------

describe("KB_SNAPSHOT_STATUS_MAP", () => {
  const ALL: KBSnapshotBuildStatus[] = ["pending", "in-progress", "completed", "errored"];

  it("[tag:kb][tag:utils] has an entry for every KBSnapshotBuildStatus", () => {
    for (const s of ALL) {
      expect(KB_SNAPSHOT_STATUS_MAP[s]).toBeDefined();
    }
  });

  it("[tag:kb][tag:utils] maps pending to IconClock", () => {
    expect(KB_SNAPSHOT_STATUS_MAP.pending.Icon).toBe(IconClock);
  });

  it("[tag:kb][tag:utils] maps in-progress to IconLoader", () => {
    expect(KB_SNAPSHOT_STATUS_MAP["in-progress"].Icon).toBe(IconLoader);
  });

  it("[tag:kb][tag:utils] maps completed to IconCircleCheck", () => {
    expect(KB_SNAPSHOT_STATUS_MAP.completed.Icon).toBe(IconCircleCheck);
  });

  it("[tag:kb][tag:utils] maps errored to IconCircleX", () => {
    expect(KB_SNAPSHOT_STATUS_MAP.errored.Icon).toBe(IconCircleX);
  });
});

// ---------------------------------------------------------------------------
// getKBStatusVisual
// ---------------------------------------------------------------------------

describe("getKBStatusVisual", () => {
  it("[tag:kb][tag:utils] returns the matching config for a known status", () => {
    expect(getKBStatusVisual("ready")).toBe(KB_STATUS_ICON_MAP.ready);
  });

  it("[tag:kb][tag:utils] falls back to in_progress visual for an unknown status", () => {
    expect(getKBStatusVisual("UnknownThing" as KBStatus)).toBe(KB_STATUS_ICON_MAP.in_progress);
  });
});

// ---------------------------------------------------------------------------
// getKBStatusLabel
// ---------------------------------------------------------------------------

describe("getKBStatusLabel", () => {
  it("[tag:kb][tag:utils] returns 'Deprecated' when deprecated=true regardless of status", () => {
    const statuses: KBStatus[] = ["in_progress", "ready", "errored", "deprecated"];
    for (const s of statuses) {
      expect(getKBStatusLabel(s, true)).toBe("Deprecated");
    }
  });

  it("[tag:kb][tag:utils] returns 'Ready' for ready", () => {
    expect(getKBStatusLabel("ready", false)).toBe("Ready");
  });

  it("[tag:kb][tag:utils] returns 'In Progress' for in_progress", () => {
    expect(getKBStatusLabel("in_progress", false)).toBe("In Progress");
  });

  it("[tag:kb][tag:utils] returns 'Errored' for errored", () => {
    expect(getKBStatusLabel("errored", false)).toBe("Errored");
  });

  it("[tag:kb][tag:utils] returns 'Deprecated' for deprecated status", () => {
    expect(getKBStatusLabel("deprecated", false)).toBe("Deprecated");
  });
});

// ---------------------------------------------------------------------------
// formatKBIndexedData
// ---------------------------------------------------------------------------

describe("formatKBIndexedData", () => {
  it("[tag:kb][tag:utils] formats files and vectors with locale separators", () => {
    expect(formatKBIndexedData(1_234, 5_678)).toBe("1,234 files / 5,678 vectors");
  });

  it("[tag:kb][tag:utils] uses 0 when filesIndexed is undefined", () => {
    expect(formatKBIndexedData(undefined, 100)).toBe("0 files / 100 vectors");
  });

  it("[tag:kb][tag:utils] uses 0 when vectors is undefined", () => {
    expect(formatKBIndexedData(50, undefined)).toBe("50 files / 0 vectors");
  });

  it("[tag:kb][tag:utils] uses 0 for both when both are undefined", () => {
    expect(formatKBIndexedData(undefined, undefined)).toBe("0 files / 0 vectors");
  });

  it("[tag:kb][tag:utils] handles zero values", () => {
    expect(formatKBIndexedData(0, 0)).toBe("0 files / 0 vectors");
  });
});

// ---------------------------------------------------------------------------
// kbStatusPollingInterval
// ---------------------------------------------------------------------------

describe("kbStatusPollingInterval", () => {
  it("[tag:kb][tag:utils] polls while status is in_progress", () => {
    expect(kbStatusPollingInterval("in_progress")).toBe(POLLING_INTERVAL);
  });

  it("[tag:kb][tag:utils] stops polling once status is ready", () => {
    expect(kbStatusPollingInterval("ready")).toBeUndefined();
  });

  it("[tag:kb][tag:utils] stops polling once status is errored", () => {
    expect(kbStatusPollingInterval("errored")).toBeUndefined();
  });

  it("[tag:kb][tag:utils] stops polling once status is deprecated", () => {
    expect(kbStatusPollingInterval("deprecated")).toBeUndefined();
  });

  it("[tag:kb][tag:utils] stops polling when status is undefined (not yet loaded)", () => {
    expect(kbStatusPollingInterval(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kbListPollingInterval
// ---------------------------------------------------------------------------

describe("kbListPollingInterval", () => {
  it("[tag:kb][tag:utils] polls while any row is in_progress", () => {
    const statuses: KBStatus[] = ["ready", "in_progress", "errored"];
    expect(kbListPollingInterval(statuses)).toBe(POLLING_INTERVAL);
  });

  it("[tag:kb][tag:utils] stops polling once every row is terminal", () => {
    const statuses: KBStatus[] = ["ready", "errored", "deprecated"];
    expect(kbListPollingInterval(statuses)).toBeUndefined();
  });

  it("[tag:kb][tag:utils] stops polling for an empty list", () => {
    expect(kbListPollingInterval([])).toBeUndefined();
  });

  it("[tag:kb][tag:utils] polls when statuses is undefined (list not yet loaded)", () => {
    expect(kbListPollingInterval(undefined)).toBe(POLLING_INTERVAL);
  });
});
