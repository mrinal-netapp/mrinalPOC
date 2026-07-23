import { describe, it, expect } from "vitest";
import {
  getSnapshotResolvedStatus,
  getSyncStatusLabel,
  isSyncMetricsApplicable,
  isManualUploadSyncDisabled,
  isManualUploadListSyncHidden,
  resolveManualUploadImportStatus,
  DAY_OF_WEEK_LABELS,
  getScheduleLabel,
} from "./dataset.utils";

// ---------------------------------------------------------------------------
// getSnapshotResolvedStatus
// ---------------------------------------------------------------------------

describe("getSnapshotResolvedStatus", () => {
  it("[tag:dataset][tag:utils] returns 'Removed' when expired is true", () => {
    const result = getSnapshotResolvedStatus({ expired: true, isCurrent: false, status: "completed" });

    expect(result.label).toBe("Removed");
    expect(result.visual.type).toBe("icon");
    expect(result.visual.color).toBe("var(--text-disabled)");
  });

  it("[tag:dataset][tag:utils] returns 'In use' when isCurrent and not expired", () => {
    const result = getSnapshotResolvedStatus({ expired: false, isCurrent: true, status: "completed" });

    expect(result.label).toBe("In use");
    expect(result.visual.type).toBe("icon");
    expect(result.visual.color).toBe("var(--notification-success)");
  });

  it("[tag:dataset][tag:utils] returns 'Available' for completed, not current, not expired", () => {
    const result = getSnapshotResolvedStatus({ expired: false, isCurrent: false, status: "completed" });

    expect(result.label).toBe("Available");
    expect(result.visual.color).toBe("var(--notification-success)");
  });

  it("[tag:dataset][tag:utils] returns 'In progress' for pending status", () => {
    const result = getSnapshotResolvedStatus({ expired: false, isCurrent: false, status: "pending" });

    expect(result.label).toBe("In progress");
    expect(result.visual.type).toBe("spinner");
  });

  it("[tag:dataset][tag:utils] returns 'In progress' for in-progress status", () => {
    const result = getSnapshotResolvedStatus({ expired: false, isCurrent: false, status: "in-progress" });

    expect(result.label).toBe("In progress");
    expect(result.visual.type).toBe("spinner");
  });

  it("[tag:dataset][tag:utils] returns 'Failed' for errored status", () => {
    const result = getSnapshotResolvedStatus({ expired: false, isCurrent: false, status: "errored" });

    expect(result.label).toBe("Failed");
    expect(result.visual.type).toBe("icon");
    expect(result.visual.color).toBe("var(--notification-error)");
  });

  it("[tag:dataset][tag:utils] expired takes precedence over isCurrent", () => {
    const result = getSnapshotResolvedStatus({ expired: true, isCurrent: true, status: "completed" });
    expect(result.label).toBe("Removed");
  });
});

// ---------------------------------------------------------------------------
// getSyncStatusLabel
// ---------------------------------------------------------------------------

describe("getSyncStatusLabel", () => {
  it("[tag:dataset][tag:utils] returns 'Completed' for Completed", () => {
    expect(getSyncStatusLabel("Completed")).toBe("Completed");
  });

  it("[tag:dataset][tag:utils] returns 'Synchronizing' for Synchronizing", () => {
    expect(getSyncStatusLabel("Synchronizing")).toBe("Synchronizing");
  });

  it("[tag:dataset][tag:utils] returns 'Failed' for Failed", () => {
    expect(getSyncStatusLabel("Failed")).toBe("Failed");
  });

  it("[tag:dataset][tag:utils] returns 'Pending' for Pending", () => {
    expect(getSyncStatusLabel("Pending")).toBe("Pending");
  });

  it("[tag:dataset][tag:utils] returns 'Never synced' for Never", () => {
    expect(getSyncStatusLabel("Never")).toBe("Never synced");
  });
});

describe("isSyncMetricsApplicable", () => {
  it("[tag:dataset][tag:utils] returns false for Never sync status", () => {
    expect(isSyncMetricsApplicable("Never")).toBe(false);
  });

  it("[tag:dataset][tag:utils] returns true for other sync statuses", () => {
    expect(isSyncMetricsApplicable("Completed")).toBe(true);
    expect(isSyncMetricsApplicable("Synchronizing")).toBe(true);
    expect(isSyncMetricsApplicable("Failed")).toBe(true);
    expect(isSyncMetricsApplicable("Pending")).toBe(true);
  });
});

describe("isManualUploadSyncDisabled", () => {
  it("[tag:dataset][tag:utils] returns true for all manual uploads", () => {
    expect(isManualUploadSyncDisabled("upload")).toBe(true);
  });

  it("[tag:dataset][tag:utils] returns false for data-source datasets", () => {
    expect(isManualUploadSyncDisabled("data-source")).toBe(false);
  });
});

describe("isManualUploadListSyncHidden", () => {
  it("[tag:dataset][tag:utils] hides list sync status for all manual uploads", () => {
    expect(isManualUploadListSyncHidden("upload")).toBe(true);
  });

  it("[tag:dataset][tag:utils] does not hide sync status for data-source datasets", () => {
    expect(isManualUploadListSyncHidden("data-source")).toBe(false);
  });
});

describe("resolveManualUploadImportStatus", () => {
  it("[tag:dataset][tag:utils] maps Never and Completed to Completed", () => {
    expect(resolveManualUploadImportStatus("Never")).toBe("Completed");
    expect(resolveManualUploadImportStatus("Completed")).toBe("Completed");
  });

  it("[tag:dataset][tag:utils] passes through in-progress and failed import states", () => {
    expect(resolveManualUploadImportStatus("Synchronizing")).toBe("Synchronizing");
    expect(resolveManualUploadImportStatus("Failed")).toBe("Failed");
  });
});

// ---------------------------------------------------------------------------
// DAY_OF_WEEK_LABELS
// ---------------------------------------------------------------------------

describe("DAY_OF_WEEK_LABELS", () => {
  it("[tag:dataset][tag:utils] has 7 entries from Sun to Sat", () => {
    expect(DAY_OF_WEEK_LABELS).toHaveLength(7);
    expect(DAY_OF_WEEK_LABELS[0]).toEqual({ value: 0, label: "Sun" });
    expect(DAY_OF_WEEK_LABELS[6]).toEqual({ value: 6, label: "Sat" });
  });
});

// ---------------------------------------------------------------------------
// getScheduleLabel
// ---------------------------------------------------------------------------

describe("getScheduleLabel", () => {
  it("[tag:dataset][tag:utils] returns null when config is null", () => {
    expect(getScheduleLabel(null)).toBeNull();
  });

  it("[tag:dataset][tag:utils] returns null when config is undefined", () => {
    expect(getScheduleLabel(undefined)).toBeNull();
  });

  it("[tag:dataset][tag:utils] returns null when schedule_type is missing", () => {
    expect(getScheduleLabel({})).toBeNull();
  });

  // -- hourly --

  it("[tag:dataset][tag:utils] hourly: defaults to 'Runs every hour' when interval_minutes is 60", () => {
    expect(getScheduleLabel({ schedule_type: "hourly", interval_minutes: 60 })).toBe("Runs every hour");
  });

  it("[tag:dataset][tag:utils] hourly: 'Runs every minute' for 1 minute", () => {
    expect(getScheduleLabel({ schedule_type: "hourly", interval_minutes: 1 })).toBe("Runs every minute");
  });

  it("[tag:dataset][tag:utils] hourly: 'Runs every 30 minutes' for 30", () => {
    expect(getScheduleLabel({ schedule_type: "hourly", interval_minutes: 30 })).toBe("Runs every 30 minutes");
  });

  it("[tag:dataset][tag:utils] hourly: 'Runs every 2 hours' for 120 minutes", () => {
    expect(getScheduleLabel({ schedule_type: "hourly", interval_minutes: 120 })).toBe("Runs every 2 hours");
  });

  it("[tag:dataset][tag:utils] hourly: mixed hours and minutes for 90 minutes", () => {
    expect(getScheduleLabel({ schedule_type: "hourly", interval_minutes: 90 })).toBe("Runs every 1 hour and 30 minutes");
  });

  it("[tag:dataset][tag:utils] hourly: plural hours with remainder for 150 minutes", () => {
    expect(getScheduleLabel({ schedule_type: "hourly", interval_minutes: 150 })).toBe("Runs every 2 hours and 30 minutes");
  });

  it("[tag:dataset][tag:utils] hourly: defaults to 60 when interval_minutes is undefined", () => {
    expect(getScheduleLabel({ schedule_type: "hourly" })).toBe("Runs every hour");
  });

  // -- daily --

  it("[tag:dataset][tag:utils] daily: with time_of_day", () => {
    expect(getScheduleLabel({ schedule_type: "daily", time_of_day: "14:30" })).toBe("Runs every day at 2:30 PM");
  });

  it("[tag:dataset][tag:utils] daily: without time_of_day", () => {
    expect(getScheduleLabel({ schedule_type: "daily", time_of_day: null })).toBe("Runs every day");
  });

  it("[tag:dataset][tag:utils] daily: midnight time", () => {
    expect(getScheduleLabel({ schedule_type: "daily", time_of_day: "00:00" })).toBe("Runs every day at 12:00 AM");
  });

  it("[tag:dataset][tag:utils] daily: noon time", () => {
    expect(getScheduleLabel({ schedule_type: "daily", time_of_day: "12:00" })).toBe("Runs every day at 12:00 PM");
  });

  // -- weekly --

  it("[tag:dataset][tag:utils] weekly: with time and days", () => {
    expect(getScheduleLabel({
      schedule_type: "weekly",
      time_of_day: "09:00",
      day_of_week: [1, 3, 5],
    })).toBe("Runs weekly at 9:00 AM on Mon, Wed, Fri");
  });

  it("[tag:dataset][tag:utils] weekly: without time or days", () => {
    expect(getScheduleLabel({ schedule_type: "weekly" })).toBe("Runs weekly");
  });

  it("[tag:dataset][tag:utils] weekly: with days but no time", () => {
    expect(getScheduleLabel({ schedule_type: "weekly", day_of_week: [0, 6] })).toBe("Runs weekly on Sun, Sat");
  });

  // -- monthly --

  it("[tag:dataset][tag:utils] monthly: with day and time", () => {
    expect(getScheduleLabel({
      schedule_type: "monthly",
      day_of_month: 15,
      time_of_day: "08:00",
    })).toBe("Runs monthly on day 15 at 8:00 AM");
  });

  it("[tag:dataset][tag:utils] monthly: without day or time", () => {
    expect(getScheduleLabel({ schedule_type: "monthly" })).toBe("Runs monthly");
  });

  it("[tag:dataset][tag:utils] monthly: with day but no time", () => {
    expect(getScheduleLabel({ schedule_type: "monthly", day_of_month: 1 })).toBe("Runs monthly on day 1");
  });

  // -- cron --

  it("[tag:dataset][tag:utils] cron: with expression", () => {
    expect(getScheduleLabel({ schedule_type: "cron", cron_expression: "0 3 * * *" })).toBe("Cron: 0 3 * * *");
  });

  it("[tag:dataset][tag:utils] cron: without expression", () => {
    expect(getScheduleLabel({ schedule_type: "cron", cron_expression: null })).toBe("Cron: —");
  });

  // -- unknown --

  it("[tag:dataset][tag:utils] unknown schedule_type is returned as-is", () => {
    expect(getScheduleLabel({ schedule_type: "custom_type" })).toBe("custom_type");
  });
});
