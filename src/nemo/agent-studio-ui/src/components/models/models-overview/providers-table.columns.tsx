import type { ColumnDef } from "@tanstack/react-table";

import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import { ModelsStatusCell } from "@/components/models/columns/cells/models-status-cell";
import type { BaseElement } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { CONNECTION_STATUS_VISUALS } from "./models-overview.consts";
import type { ProviderRow } from "./models-overview.types";

/** BaseTable requires every row to extend `BaseElement`, i.e. have an `id`. */
type ProvidersTableRow = ProviderRow & BaseElement;

/** Row-action callbacks wired by the Providers panel into the kebab menu. */
type ProvidersTableCallbacks = {
  onEditProxy: (row: ProvidersTableRow) => void;
};

const numberFormatter = new Intl.NumberFormat("en-US");

/*
 * Cells are all shared components or ui-lib primitives — keeps the file
 * free of top-level React components so `react-refresh/only-export-components`
 * stays happy.
 */
const providersTableColumns: ColumnDef<ProvidersTableRow>[] = [
  {
    accessorKey: "name",
    header: "Provider",
    size: 200,
    minSize: 160,
    cell: ({ row }) => (
      <Typography Component="span" fontSize="fs14" boldness="semibold">
        {row.original.name}
      </Typography>
    ),
  },
  {
    accessorKey: "status",
    header: "Connection status",
    size: 180,
    minSize: 140,
    cell: ({ row }) => {
      const statusCell = (
        <ModelsStatusCell visual={CONNECTION_STATUS_VISUALS[row.original.status]} />
      );
      // Surface the backend statusMessage (e.g. "Invalid API key") via the
      // shared Tooltip when present; otherwise render the bare status cell.
      return row.original.statusMessage ? (
        <Tooltip
          content={row.original.statusMessage}
          trigger={<span className="models-overview__status-wrap">{statusCell}</span>}
        />
      ) : (
        statusCell
      );
    },
  },
  {
    accessorKey: "capabilities",
    header: "Capabilities",
    size: 260,
    minSize: 200,
    cell: ({ row }) => (
      <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
        {row.original.capabilities}
      </Typography>
    ),
  },
  {
    accessorKey: "concurrent_requests",
    header: "Concurrent requests",
    size: 180,
    minSize: 140,
    cell: ({ row }) => (
      <Typography Component="span" fontSize="fs14">
        {numberFormatter.format(row.original.concurrent_requests)}
      </Typography>
    ),
  },
  {
    accessorKey: "buffer_size",
    header: "Buffer size",
    size: 160,
    minSize: 120,
    cell: ({ row }) => (
      <Typography Component="span" fontSize="fs14">
        {numberFormatter.format(row.original.buffer_size)}
      </Typography>
    ),
  },
];

/**
 * Providers table columns with the row-actions kebab appended. Mirrors the
 * Models tab (`createModelsTableColumns`): the shared `ActionsCell` renders the
 * kebab menu, so this file stays free of top-level components and
 * `react-refresh/only-export-components` stays happy.
 */
function createProvidersTableColumns({
  onEditProxy,
}: ProvidersTableCallbacks): ColumnDef<ProvidersTableRow>[] {
  return [
    ...providersTableColumns,
    {
      id: "actions",
      header: "Actions",
      size: 56,
      minSize: 56,
      enableSorting: false,
      cell: ({ row }) => (
        <ActionsCell
          row={row.original}
          name={row.original.name}
          menuItems={[
            {
              label: "Edit proxy configuration",
              onClick: () => onEditProxy(row.original),
            },
          ]}
        />
      ),
    },
  ];
}

export { createProvidersTableColumns, providersTableColumns };
export type { ProvidersTableCallbacks, ProvidersTableRow };
