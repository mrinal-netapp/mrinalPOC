import type { ColumnDef } from "@tanstack/react-table";

import type { BaseElement, BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { ExplorerNode } from "@/api/explorer-api";
import type { ExplorerSelectionMode } from "@/consts/explorer-catalog";

// -- Row type --

export interface ConnectorBrowserRow extends BaseElement {
  /** Globally-unique explorer node id (also the BaseTable row id). */
  id: string;
  name: string;
  /** Explorer node type (folder, file, table, volume, …). */
  nodeType: string;
  /** Optional connector-supplied kind badge text. */
  kind: string;
  /** Whether clicking the name drills into this node. */
  navigable: boolean;
  /** Whether this node can be selected into the dataset scope. */
  selectable: boolean;
  /** Human-readable detail (size, junction path, …). */
  detail: string;
  /** The underlying node, kept for resolving selections → resource selectors. */
  node: ExplorerNode;
}

const TYPE_LABELS: Record<string, string> = {
  folder: "Folder",
  file: "File",
  database: "Database",
  schema: "Schema",
  table: "Table",
  view: "View",
  column: "Column",
  service: "Service",
  resource: "Resource",
  instance: "Instance",
  cluster: "Cluster",
  volume: "Volume",
  svm: "SVM",
  snapshot: "Snapshot",
  bucket: "Bucket",
  metric_category: "Metric category",
};

export function humanizeType(type: string): string {
  return TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** Display/filter value for the Type column (humanized type + optional kind badge). */
export function formatConnectorBrowseType(
  row: Pick<ConnectorBrowserRow, "nodeType" | "kind">,
): string {
  return `${humanizeType(row.nodeType)}${row.kind ? ` · ${row.kind}` : ""}`;
}

// -- Column factory --

export function createConnectorBrowserColumns(
  onNavigate: (row: ConnectorBrowserRow) => void,
): ColumnDef<ConnectorBrowserRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 320,
      minSize: 200,
      cell: ({ row }) => {
        const { navigable, name } = row.original;
        if (navigable) {
          return (
            <button
              type="button"
              className="ds-name-link"
              onClick={() => onNavigate(row.original)}
            >
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                {name}
              </Typography>
            </button>
          );
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {name}
          </Typography>
        );
      },
    },
    {
      accessorKey: "nodeType",
      header: "Type",
      size: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatConnectorBrowseType(row.original)}
        </Typography>
      ),
    },
    {
      accessorKey: "detail",
      header: "Details",
      size: 200,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.detail || "—"}
        </Typography>
      ),
    },
  ];
}

// -- Table options factory --

/**
 * Selection is gated to the provider's selectable node types. Multi-select is
 * enabled only when the provider's data access model allows it.
 */
export function createConnectorBrowserTableOptions(
  selectionMode: ExplorerSelectionMode,
): BaseTableOptions {
  return {
    enableColumnSorting: true,
    enableRowSelection: (row) => "selectable" in row && Boolean((row as ConnectorBrowserRow).selectable),
    enableRowMultiSelection: selectionMode === "multi",
  };
}
