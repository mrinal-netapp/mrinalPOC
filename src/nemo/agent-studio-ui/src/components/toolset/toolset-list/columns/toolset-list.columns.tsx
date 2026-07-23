import type React from "react"
import { type ColumnDef } from "@tanstack/react-table"
import { IconDotsVertical } from "@tabler/icons-react"

import { Button } from "@/ui-lib/base-components/button/button"
import { buttonVariants } from "@/ui-lib/base-components/button/button.variants"
import { SortIcon } from "@/ui-lib/base-components/baseTableMcpBxp/sortIcon"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { StatusIcon } from "@/components/data-source/utils/status-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip"

import { TOOLSET_STRINGS } from "../toolset-list.consts"
import type { ToolStatus } from "../toolset-list.types"
import type { ToolsetRow } from "../toolset-list.types"
import { TOOLSET_STATUS_ICON_MAP } from "../utils/toolset-status.utils"

export type ToolsetTableActions = {
  onViewDetails: (toolId: string) => void
  onEdit: (toolId: string) => void
  onDeprecate: (toolId: string, toolName: string) => void
  onDelete: (toolId: string, toolName: string) => void
}

function getStatusLabel(status: ToolStatus): string {
  if (status === "healthy") return TOOLSET_STRINGS.HEALTHY_LABEL
  if (status === "unhealthy") return TOOLSET_STRINGS.UNHEALTHY_LABEL
  if (status === "deploying") return TOOLSET_STRINGS.DEPLOYING_LABEL
  return TOOLSET_STRINGS.UNKNOWN_LABEL
}

function renderStatusContent(status: ToolStatus): React.ReactElement {
  return (
    <span className="toolset-status-cell">
      <StatusIcon visual={TOOLSET_STATUS_ICON_MAP[status]} />
      <Typography Component="span" fontSize="fs14" boldness="regular">
        {getStatusLabel(status)}
      </Typography>
    </span>
  )
}

function renderStatusHoverContent(status: ToolStatus, statusDetails: string): React.ReactElement {
  return (
    <div className="toolset-status-tooltip">
      <span className="toolset-status-tooltip__header">
        {renderStatusContent(status)}
      </span>
      {statusDetails ? <p className="toolset-status-tooltip__message">{statusDetails}</p> : null}
    </div>
  )
}

function renderSortableHeader(label: string, column: { getIsSorted: () => false | "asc" | "desc"; getCanSort: () => boolean; toggleSorting: (desc?: boolean) => void; clearSorting: () => void; }): React.ReactElement | string {
  const current = column.getIsSorted()

  if (!column.getCanSort()) return label

  return (
    <button
      type="button"
      className={buttonVariants({ variant: "flat" })}
      onClick={() => {
        if (current === "asc") column.toggleSorting(true)
        else if (current === "desc") column.clearSorting()
        else column.toggleSorting(false)
      }}
    >
      {label}
      <SortIcon direction={current} />
    </button>
  )
}

export function createToolsetTableColumns(actions: ToolsetTableActions): ColumnDef<ToolsetRow>[] {
  return [
    {
      accessorKey: "name",
      size: 220,
      minSize: 180,
      header: ({ column }) => renderSortableHeader("Name", column),
      cell: ({ row }) => (
        <button
          type="button"
          className="toolset-name-link"
          onClick={(e) => {
            e.stopPropagation()
            actions.onViewDetails(row.original.id)
          }}
        >
          {row.getValue("name")}
        </button>
      ),
    },
    {
      accessorKey: "type",
      size: 120,
      minSize: 110,
      header: ({ column }) => renderSortableHeader("Type", column),
      cell: ({ row }) => <div className="dt-cell-text">{row.getValue("type")}</div>,
    },
    {
      accessorKey: "status",
      size: 160,
      minSize: 140,
      header: ({ column }) => renderSortableHeader("Status", column),
      cell: ({ row }) => {
        const status = row.original.status

        return (
          <Tooltip
            className="toolset-status-tooltip-popup"
            side="top"
            sideOffset={8}
            content={renderStatusHoverContent(status, row.original.statusDetails)}
            trigger={(
              <button type="button" className="toolset-status-trigger">
                {renderStatusContent(status)}
              </button>
            )}
          />
        )
      },
    },
    {
      accessorKey: "associatedAgents",
      size: 260,
      minSize: 220,
      header: ({ column }) => renderSortableHeader("Associated agents", column),
      cell: ({ row }) => (
        <div className="dt-cell-text">{row.getValue("associatedAgents")}</div>
      ),
    },
    {
      accessorKey: "labels",
      size: 180,
      minSize: 150,
      header: ({ column }) => renderSortableHeader("Labels", column),
      cell: ({ row }) => {
        const labels = row.original.labels
        return (
          <div className="toolset-label-list">
            {labels.map((label) => (
              <span key={`${row.original.id}-${label}`} className="toolset-label-pill">
                {label}
              </span>
            ))}
          </div>
        )
      },
    },
    {
      id: "actions",
      header: "Actions",
      size: 80,
      minSize: 64,
      enableHiding: false,
      enableSorting: false,
      cell: ({ row }) => {
        const stopClick = (e: React.MouseEvent) => e.stopPropagation()
        const stopPointer = (e: React.PointerEvent) => e.stopPropagation()
        const stopKey = (e: React.KeyboardEvent) => e.stopPropagation()
        const actionsAriaLabel = `${TOOLSET_STRINGS.ACTIONS_ARIA_LABEL_PREFIX} ${row.original.name}`
        const toolId = row.original.id
        const toolName = row.original.name

        return (
          <div className="dt-cell-action">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="icon" icon={<IconDotsVertical size={18} />} aria-label={actionsAriaLabel} />}
                onClick={stopClick}
                onPointerDown={stopPointer}
                onKeyDown={stopKey}
              />
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => actions.onViewDetails(toolId)}>View details</DropdownMenuItem>
                  {/* <DropdownMenuItem onClick={() => actions.onDeprecate(toolId, toolName)}>Deprecate</DropdownMenuItem> */}
                  <DropdownMenuItem onClick={() => actions.onEdit(toolId)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.onDelete(toolId, toolName)}>Delete</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ]
}

export const toolsetTableColumns = createToolsetTableColumns({
  onViewDetails: () => {},
  onEdit: () => {},
  onDeprecate: () => {},
  onDelete: () => {},
})
