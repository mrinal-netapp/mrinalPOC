import type { ColumnDef } from "@tanstack/react-table";

import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import { ModelsStatusCell } from "@/components/models/columns/cells/models-status-cell";
import { ModelCostCell } from "@/components/models/columns/cells/model-cost-cell";
import type { BaseElement } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip";
import { Typography } from "@/ui-lib/base-components/typography/typography";

import { CONNECTION_STATUS_VISUALS } from "./models-overview.consts";
import type { ModelRow } from "./models-overview.types";

/** BaseTable requires every row to extend `BaseElement`, i.e. have an `id`. */
type ModelsTableRow = ModelRow & BaseElement;

type ModelsTableCallbacks = {
  onNavigateDetail: (modelId: string) => void;
  onEdit: (modelId: string) => void;
  onDelete: (modelId: string, modelName: string) => void;
};

/*
 * Cells are all shared components or ui-lib primitives — keeps the file
 * free of top-level React components so `react-refresh/only-export-components`
 * stays happy.
 *
 * Table actions are fully wired so rows expose the expected kebab menu:
 * Details, Edit, Delete.
 */
function createModelsTableColumns({
  onNavigateDetail,
  onEdit,
  onDelete,
}: ModelsTableCallbacks): ColumnDef<ModelsTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 180,
      cell: ({ row }) => (
        <button
          type="button"
          className="models-overview__name-link"
          onClick={() => onNavigateDetail(row.original.model_id || row.original.id)}
        >
          <Typography Component="span" fontSize="fs14" color="var(--text-button-primary)">
            {row.original.name}
          </Typography>
        </button>
      ),
    },
    {
      accessorKey: "type",
      header: "Type",
      size: 140,
      minSize: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
          {row.original.type}
        </Typography>
      ),
    },
    {
      accessorKey: "provider_name",
      header: "Provider",
      size: 180,
      minSize: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
          {row.original.provider_name}
        </Typography>
      ),
    },
    {
      accessorKey: "dependentsCount",
      header: "Associated resources",
      size: 170,
      minSize: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" color="var(--text-secondary)">
          {row.original.dependentsCount ?? 0}
        </Typography>
      ),
    },
    {
      id: "inputCost",
      header: "Input cost (USD per 1M tokens)",
      size: 210,
      minSize: 170,
      enableSorting: false,
      cell: ({ row }) => (
        <ModelCostCell
          providerId={row.original.provider_id}
          providerModelId={row.original.provider_model_id}
          customCost={row.original.inputCostPer1M}
          costType="input"
        />
      ),
    },
    {
      id: "outputCost",
      header: "Output cost (USD per 1M tokens)",
      size: 215,
      minSize: 170,
      enableSorting: false,
      cell: ({ row }) => (
        <ModelCostCell
          providerId={row.original.provider_id}
          providerModelId={row.original.provider_model_id}
          customCost={row.original.outputCostPer1M}
          costType="output"
        />
      ),
    },
    {
      accessorKey: "connectionStatus",
      header: "Status",
      size: 160,
      minSize: 120,
      cell: ({ row }) => {
        const statusCell = (
          <ModelsStatusCell
            visual={CONNECTION_STATUS_VISUALS[row.original.connectionStatus ?? "Disconnected"]}
          />
        );
        // Surface the provider's statusMessage (e.g. "Invalid API key") via the
        // shared Tooltip when present; otherwise render the bare status cell.
        return row.original.connectionMessage ? (
          <Tooltip
            content={row.original.connectionMessage}
            trigger={<span className="models-overview__status-wrap">{statusCell}</span>}
          />
        ) : (
          statusCell
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      size: 56,
      minSize: 56,
      enableSorting: false,
      cell: ({ row }) => {
        const modelId = row.original.model_id || row.original.id;
        return (
          <ActionsCell
            row={row.original}
            name={row.original.name}
            menuItems={[
              {
                label: "Details",
                onClick: () => onNavigateDetail(modelId),
              },
              {
                label: "Edit",
                onClick: () => onEdit(modelId),
              },
              {
                label: "Delete",
                onClick: () => onDelete(modelId, row.original.name),
              },
            ]}
          />
        );
      },
    },
  ];
}

export { createModelsTableColumns };
export type { ModelsTableCallbacks, ModelsTableRow };
