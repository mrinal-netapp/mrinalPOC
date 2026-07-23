import type { ColumnDef } from "@tanstack/react-table"

import { Typography } from "@/ui-lib/base-components/typography/typography"
import type { ActivityEvent, ActivityEventStatus } from "../../model-detail-page.types"

const STATUS_DOT_CLASS: Record<ActivityEventStatus, string> = {
  error: "model-activity__status-dot--error",
  success: "model-activity__status-dot--success",
  warning: "model-activity__status-dot--warning",
}

const STATUS_LABEL: Record<ActivityEventStatus, string> = {
  error: "Error",
  success: "Success",
  warning: "Warning",
}

const ACTIVITY_COLUMNS: ColumnDef<ActivityEvent>[] = [
  {
    accessorKey: "event",
    header: "Event",
    size: 220,
    cell: ({ row }) => (
      <Typography fontSize="fs14" Component="span">
        {row.getValue("event")}
      </Typography>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    size: 140,
    cell: ({ row }) => {
      const status = row.getValue("status") as ActivityEventStatus
      return (
        <div className="model-activity__status">
          <span className={`model-activity__status-dot ${STATUS_DOT_CLASS[status]}`} />
          <Typography fontSize="fs14" Component="span">
            {STATUS_LABEL[status]}
          </Typography>
        </div>
      )
    },
  },
  {
    accessorKey: "details",
    header: "Details",
    size: 400,
    cell: ({ row }) => (
      <Typography fontSize="fs14" Component="span">
        {row.getValue("details")}
      </Typography>
    ),
  },
  {
    accessorKey: "timestamp",
    header: "Timestamp",
    size: 200,
    cell: ({ row }) => (
      <Typography fontSize="fs14" Component="span">
        {row.getValue("timestamp")}
      </Typography>
    ),
  },
]

export { ACTIVITY_COLUMNS, STATUS_DOT_CLASS, STATUS_LABEL }
