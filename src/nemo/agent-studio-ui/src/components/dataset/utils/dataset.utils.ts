import {
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
  IconCircleMinus,
} from "@tabler/icons-react";

import type { ScheduleConfig } from "@/api/api.types";
import type { SynchronizationStatus, SnapshotStatus, DatasetInputType } from "@/api/dataset.types";
import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";

// -- Sync status icon map --

const SYNC_STATUS_ICON_MAP: Record<SynchronizationStatus, StatusVisualConfig> = {
  Completed: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Synchronizing: { type: "spinner", color: "var(--notification-information)" },
  Failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  Pending: { type: "icon", Icon: IconAlertTriangle, color: "var(--notification-warning)" },
  Never: { type: "icon", Icon: IconCircleMinus, color: "var(--text-disabled)" },
};

// -- Sync status display labels --

const SYNC_STATUS_DISPLAY_LABEL: Record<SynchronizationStatus, string> = {
  Completed: "Completed",
  Synchronizing: "Synchronizing",
  Failed: "Failed",
  Pending: "Pending",
  Never: "Never synced",
};

function getSyncStatusLabel(status: SynchronizationStatus): string {
  return SYNC_STATUS_DISPLAY_LABEL[status];
}

/** Schedule / last-sync / next-sync metrics only apply when sync is in play. */
function isSyncMetricsApplicable(syncStatus: SynchronizationStatus): boolean {
  return syncStatus !== "Never";
}

/** Sync schedule / sync tab — not applicable for manual uploads. */
function isManualUploadSyncDisabled(
  inputType: DatasetInputType | undefined,
): boolean {
  return inputType === "upload";
}

/** List "Sync status" column — not applicable for manual uploads. */
function isManualUploadListSyncHidden(
  inputType: DatasetInputType | undefined,
): boolean {
  return inputType === "upload";
}

/** Map backend sync enum to the import-status vocabulary shown on the detail header. */
function resolveManualUploadImportStatus(syncStatus: SynchronizationStatus): SynchronizationStatus {
  if (syncStatus === "Never" || syncStatus === "Completed") return "Completed";
  return syncStatus;
}

// -- Input type labels --

const INPUT_TYPE_LABELS: Record<DatasetInputType, string> = {
  "data-source": "Data source",
  upload: "Upload",
};

// -- Snapshot resolved status --

interface SnapshotResolvedStatus {
  visual: StatusVisualConfig;
  label: string;
}

function getSnapshotResolvedStatus(
  { expired, isCurrent, status }: { expired: boolean; isCurrent: boolean; status: SnapshotStatus },
): SnapshotResolvedStatus {
  if (expired) {
    return {
      visual: { type: "icon", Icon: IconCircleMinus, color: "var(--text-disabled)" },
      label: "Removed",
    };
  }

  if (isCurrent) {
    return {
      visual: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
      label: "In use",
    };
  }

  if (status === "completed") {
    return {
      visual: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
      label: "Available",
    };
  }

  if (status === "pending" || status === "in-progress") {
    return {
      visual: { type: "spinner", color: "var(--notification-information)" },
      label: "In progress",
    };
  }

  // Fallback for errored or unknown states
  return {
    visual: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
    label: "Failed",
  };
}



// -- Day-of-week labels (Sun=0 … Sat=6) --

const DAY_OF_WEEK_LABELS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
] as const;

const DAY_NAMES = DAY_OF_WEEK_LABELS.map((d) => d.label);

// -- Schedule label formatting --

function formatTime(timeOfDay: string | null | undefined): string {
  if (!timeOfDay) return "";
  const [h, m] = timeOfDay.split(":");
  const hour = Number(h);
  const minute = m ?? "00";
  const period = hour >= 12 ? "PM" : "AM";
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}:${minute.padStart(2, "0")} ${period}`;
}

function getScheduleLabel(config: ScheduleConfig | null | undefined): string | null {
  if (!config?.schedule_type) return null;

  switch (config.schedule_type) {
    case "hourly": {
      const minutes = config.interval_minutes ?? 60;
      if (minutes < 60) return minutes === 1 ? "Runs every minute" : `Runs every ${minutes} minutes`;
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      if (remainder === 0) return hours === 1 ? "Runs every hour" : `Runs every ${hours} hours`;
      return hours === 1
        ? `Runs every 1 hour and ${remainder} minutes`
        : `Runs every ${hours} hours and ${remainder} minutes`;
    }
    case "daily": {
      const time = formatTime(config.time_of_day);
      return time ? `Runs every day at ${time}` : "Runs every day";
    }
    case "weekly": {
      const time = formatTime(config.time_of_day);
      const days = (config.day_of_week ?? [])
        .map((d) => DAY_NAMES[d])
        .filter(Boolean)
        .join(", ");
      const suffix = [time && `at ${time}`, days && `on ${days}`].filter(Boolean).join(" ");
      return suffix ? `Runs weekly ${suffix}` : "Runs weekly";
    }
    case "monthly": {
      const time = formatTime(config.time_of_day);
      const day = config.day_of_month;
      const suffix = [day != null && `on day ${day}`, time && `at ${time}`].filter(Boolean).join(" ");
      return suffix ? `Runs monthly ${suffix}` : "Runs monthly";
    }
    case "cron":
      return `Cron: ${config.cron_expression ?? "—"}`;
    default:
      return config.schedule_type;
  }
}

export { SYNC_STATUS_ICON_MAP, getSyncStatusLabel, isSyncMetricsApplicable, isManualUploadSyncDisabled, isManualUploadListSyncHidden, resolveManualUploadImportStatus, getSnapshotResolvedStatus, INPUT_TYPE_LABELS, DAY_OF_WEEK_LABELS, DAY_NAMES, getScheduleLabel };
export type { SnapshotResolvedStatus };
