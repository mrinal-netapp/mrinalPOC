import type { ColumnDef } from "@tanstack/react-table"

import { RadioButton } from "@/ui-lib/base-components/radio-button/radio-button"
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip"

import type { CatalogTemplateRow } from "./catalog.types"
import { ADD_TOOL_STRINGS } from "../add-tool.consts"

/**
 * Radio select column — renders a RadioButton per row.
 * Must be rendered inside a RadioGroup provider that sets
 * `value` to the currently selected template id.
 */
export function getRadioSelectColumn(): ColumnDef<CatalogTemplateRow> {
  return {
    id: "select",
    size: 56,
    minSize: 56,
    enableResizing: false,
    enableSorting: false,
    enableHiding: false,
    header: () => null,
    cell: ({ row }) => (
      <div className="dt-cell-checkbox">
        <RadioButton
          value={row.original.id}
          ariaLabel={`${ADD_TOOL_STRINGS.CATALOG_SELECT_TEMPLATE_ARIA} ${row.original.name}`}
        />
      </div>
    ),
  }
}

export function createCatalogTemplateColumns(): ColumnDef<CatalogTemplateRow>[] {
  return [
    {
      accessorKey: "name",
      size: 200,
      minSize: 160,
      header: ADD_TOOL_STRINGS.CATALOG_NAME_LABEL,
      cell: ({ row }) => <div className="dt-cell-text">{row.getValue("name")}</div>,
    },
    {
      accessorKey: "description",
      size: 360,
      minSize: 200,
      header: ADD_TOOL_STRINGS.CATALOG_DESCRIPTION_LABEL,
      cell: ({ row }) => {
        const description = row.getValue("description") as string
        return (
          <Tooltip
            content={description}
            trigger={<div className="dt-cell-text" tabIndex={0}>{description}</div>}
            side="top"
          />
        )
      },
    },
    {
      accessorKey: "locationType",
      size: 130,
      minSize: 100,
      header: "Location type",
      cell: ({ row }) => <div className="dt-cell-text">{row.getValue("locationType")}</div>,
    },
  ]
}
