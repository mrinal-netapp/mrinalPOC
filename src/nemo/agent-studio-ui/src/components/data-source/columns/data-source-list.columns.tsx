import type { ColumnDef } from "@tanstack/react-table";
import type { DataSourceListItem } from "@/api/data-source.types";
import { formatDataSourceCategoryLabel } from "@/api/data-source-category.utils";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { ConnectionStatusCell } from "@/components/data-source/columns/cells/status-cell";
import { AssociatedDatasetsCell } from "@/components/data-source/columns/cells/associated-datasets-cell";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";
import { SOURCE_TYPE_LABELS } from "@/routes/pages/data-management/data-source/create-edit/form/data-source-form.consts";

// -- Row type adaptor --

export interface DataSourceTableRow extends DataSourceListItem {
  id: string;
}

// -- Callbacks --

export interface DataSourceColumnsCallbacks {
  onNavigateDetail: (dsrcId: string) => void;
  onNavigateDataset?: (dsetId: string) => void;
  actionMenuItems: ActionMenuItem<DataSourceTableRow>[] | ((row: DataSourceTableRow) => ActionMenuItem<DataSourceTableRow>[]);
}

// -- Column factory --

function createDataSourceListColumns(
  callbacks: DataSourceColumnsCallbacks,
): ColumnDef<DataSourceTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 220,
      cell: ({ row }) => {
        const { deprecated } = row.original;
        if (deprecated) {
          return (
            <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-disabled)">
              {row.original.name}
            </Typography>
          );
        }
        return (
          <button
            type="button"
            className="ds-name-link"
            onClick={() => callbacks.onNavigateDetail(row.original.dsrc_id)}
          >
            <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
              {row.original.name}
            </Typography>
          </button>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Connection status",
      size: 160,
      cell: ({ row }) => (
        <ConnectionStatusCell
          status={row.original.status}
          lastValidatedAt={row.original.last_validated_at}
          connectionTestStatus={row.original.connection_test_status}
          deprecated={row.original.deprecated}
        />
      ),
    },
    {
      accessorKey: "source_type",
      header: "Type",
      size: 100,
      cell: ({ row }) => {
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        const typeLabel =
          formatDataSourceCategoryLabel(row.original.category)
          ?? (row.original.source_type ? SOURCE_TYPE_LABELS[row.original.source_type] ?? row.original.source_type : "—");
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {typeLabel}
          </Typography>
        );
      },
    },
    {
      id: "associated_datasets",
      header: "Associated datasets",
      size: 200,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => (
        <AssociatedDatasetsCell
          datasets={row.original.associated_datasets}
          totalCount={row.original.associated_datasets_count}
          deprecated={row.original.deprecated}
          onNavigate={callbacks.onNavigateDataset}
        />
      ),
    },
    {
      accessorKey: "labels",
      header: "Labels",
      size: 160,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => {
        const { labels } = row.original;
        if (!labels.length) return <span className="ds-cell-placeholder">—</span>;
        return (
          <ChipList
            values={labels}
            getLabel={(v) => String(v)}
            isRemovable={false}
            isDisabled={row.original.deprecated}
          />
        );
      },
    },
    {
      accessorKey: "created_at",
      header: "Created",
      size: 180,
      minSize: 140,
      cell: ({ row }) => {
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {formatDateTimeFull(row.original.created_at)}
          </Typography>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      size: 75,
      minSize: 75,
      maxSize: 75,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => {
        const items = typeof callbacks.actionMenuItems === "function"
          ? callbacks.actionMenuItems(row.original)
          : callbacks.actionMenuItems;
        return (
          <ActionsCell
            row={row.original}
            name={row.original.name}
            menuItems={items}
          />
        );
      },
    },
  ];
}

export { createDataSourceListColumns };
export type { ActionMenuItem };
