import type { ColumnDef } from "@tanstack/react-table";
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
} from "@tabler/icons-react";

import type { KBDetailActivityEntry } from "@/api/kb.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import type { StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";

export interface KBActivityTableRow extends KBDetailActivityEntry {
  id: string;
}

const ACTIVITY_STATUS_MAP: Record<string, StatusVisualConfig> = {
  ready: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  success: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  done: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  completed: { type: "icon", Icon: IconCircleCheck, color: "var(--notification-success)" },
  failed: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  failure: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  errored: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  error: { type: "icon", Icon: IconCircleX, color: "var(--notification-error)" },
  pending: { type: "icon", Icon: IconClock, color: "var(--notification-information)" },
  in_progress: { type: "spinner", color: "var(--notification-information)" },
  "in-progress": { type: "spinner", color: "var(--notification-information)" },
  running: { type: "spinner", color: "var(--notification-information)" },
};

const DEFAULT_ACTIVITY_STATUS: StatusVisualConfig = {
  type: "icon",
  Icon: IconClock,
  color: "var(--text-secondary)",
};

function formatDurationMinutes(durationMinutes: number | undefined): string {
  if (durationMinutes == null) return "—";
  return durationMinutes === 1 ? "1 minute" : `${durationMinutes} minutes`;
}

function getActivityStatusVisual(status: string | undefined): StatusVisualConfig {
  if (!status) return DEFAULT_ACTIVITY_STATUS;
  const normalized = status.toLowerCase();
  return ACTIVITY_STATUS_MAP[normalized] ?? DEFAULT_ACTIVITY_STATUS;
}

function createKBActivityColumns(): ColumnDef<KBActivityTableRow>[] {
  return [
    {
      accessorKey: "event",
      header: "Event",
      size: 180,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.event ?? "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 140,
      cell: ({ row }) => {
        const visual = getActivityStatusVisual(row.original.status);
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <StatusIcon visual={visual} />
            <Typography Component="span" fontSize="fs14" boldness="regular">
              {row.original.status ?? "—"}
            </Typography>
          </span>
        );
      },
    },
    {
      accessorKey: "duration",
      header: "Duration",
      size: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatDurationMinutes(row.original.duration)}
        </Typography>
      ),
    },
    {
      accessorKey: "timestamp",
      header: "Timestamp",
      size: 180,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.timestamp ? formatDateTimeFull(row.original.timestamp) : "—"}
        </Typography>
      ),
    },
  ];
}

export { createKBActivityColumns, formatDurationMinutes };
