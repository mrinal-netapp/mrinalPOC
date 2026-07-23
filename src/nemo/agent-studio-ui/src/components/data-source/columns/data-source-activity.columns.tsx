import type { ColumnDef } from "@tanstack/react-table";
import type { DataSourceActivityItem } from "@/api/data-source.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { ActivityStatusCell } from "@/components/data-source/columns/cells/status-cell";

// -- Row type adaptor (BaseTable requires `id`) --

export interface ActivityTableRow extends DataSourceActivityItem {
  id: string;
}

// -- Column factory --

function createDataSourceActivityColumns(): ColumnDef<ActivityTableRow>[] {
  return [
    {
      accessorKey: "created_at",
      header: "Timestamp",
      size: 200,
      minSize: 160,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatDateTimeFull(row.original.created_at)}
        </Typography>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 150,
      cell: ({ row }) => <ActivityStatusCell status={row.original.status} />,
    },
    {
      accessorKey: "event",
      header: "Event",
      size: 200,
      minSize: 160,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.event}
        </Typography>
      ),
    },
    {
      accessorKey: "details",
      header: "Details",
      size: 300,
      minSize: 200,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.details ?? "—"}
        </Typography>
      ),
    },
  ];
}

export { createDataSourceActivityColumns };
