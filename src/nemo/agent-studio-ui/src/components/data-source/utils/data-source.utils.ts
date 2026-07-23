import {
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
  IconCircleMinus,
} from "@tabler/icons-react";

import type { DataSourceStatus, ActivityStatus, ScanDepth, ScanStatus } from "@/api/data-source.types";
import type { DatasetStatus } from "@/api/dataset.types";

// -- Status visual config (single source of truth) --

interface StatusVisualConfig {
  type: "icon" | "spinner";
  Icon?: typeof IconCircleCheck;
  color: string;
}

const STATUS_ICON_MAP: Record<DataSourceStatus, StatusVisualConfig> = {
  Initializing: { type: "spinner", color: "var(--notification-information)" },
  Healthy: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Unhealthy: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  Failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
};

const SCAN_STATUS_ICON_MAP: Record<ScanStatus, StatusVisualConfig> = {
  Completed: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Unscanned: { type: "icon", Icon: IconAlertTriangle, color: "var(--notification-warning)" },
  Scanning: { type: "spinner", color: "var(--notification-information)" },
  Failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
};

const DATASET_STATUS_ICON_MAP: Record<DatasetStatus, StatusVisualConfig> = {
  Draft: { type: "icon", Icon: IconCircleMinus, color: "var(--text-disabled)" },
  Healthy: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Importing: { type: "spinner", color: "var(--notification-information)" },
  Ready: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Unhealthy: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  Failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
};

const ACTIVITY_STATUS_ICON_MAP: Record<ActivityStatus, StatusVisualConfig> = {
  Success: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  Failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  "In Progress": { type: "spinner", color: "var(--notification-information)" },
  Warning: { type: "icon", Icon: IconAlertTriangle, color: "var(--notification-warning)" },
};

const DEPRECATED_VISUAL: StatusVisualConfig = {
  type: "icon",
  Icon: IconCircleMinus,
  color: "var(--text-disabled)",
};

// -- Display labels --

const SCAN_STATUS_DISPLAY_LABEL: Record<ScanStatus, string> = {
  Completed: "Scanned",
  Unscanned: "Unscanned",
  Scanning: "Scanning",
  Failed: "Failed",
};

function getScanStatusLabel(status: ScanStatus): string {
  return SCAN_STATUS_DISPLAY_LABEL[status];
}

// -- Scan depth labels --

const SCAN_DEPTH_LABELS: Record<ScanDepth, string> = {
  none: "None",
  all_levels: "All folder levels",
  top_5_levels: "Top 5 folder levels",
  top_2_levels: "Top 2 folder levels",
  custom: "Custom",
};

function getScanDepthDisplay(depth: ScanDepth | undefined, customDepth: number | null | undefined): string {
  if (!depth) return "-";
  const label = SCAN_DEPTH_LABELS[depth];
  if (depth === "custom" && customDepth != null) {
    return `${label} (${customDepth} levels)`;
  }
  return label;
}

// -- Date formatting --

function formatDateShort(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(isoDate));
}

function formatDateTimeFull(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(isoDate));
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "-";
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[i]}`;
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "-";
  return n.toLocaleString("en-US");
}

export {
  STATUS_ICON_MAP,
  SCAN_STATUS_ICON_MAP,
  DATASET_STATUS_ICON_MAP,
  ACTIVITY_STATUS_ICON_MAP,
  DEPRECATED_VISUAL,
  getScanStatusLabel,
  getScanDepthDisplay,
  SCAN_DEPTH_LABELS,
  formatDateShort,
  formatDateTimeFull,
  formatBytes,
  formatNumber,
};
export type { StatusVisualConfig };
