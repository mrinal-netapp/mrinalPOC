import { type ColumnDef } from "@tanstack/react-table"
import { IconArrowsSort, IconArrowUp, IconArrowDown, IconDots } from "@tabler/icons-react"
import { Button } from "@/ui-lib/base-components/button/button"
import { buttonVariants } from "@/ui-lib/base-components/button/button.variants"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import type { JobTableRow } from "../baseTable.types"

export const jobColumns: ColumnDef<JobTableRow>[] = [
    {
        accessorKey: "id",
        size: 160,
        minSize: 120,
        header: ({ column }) => {
            const current = column.getIsSorted()
            const Icon = current === "asc" ? IconArrowUp : current === "desc" ? IconArrowDown : IconArrowsSort
            if (!column.getCanSort()) return "ID"
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
                    ID
                    <Icon size={16} />
                </button>
            )
        },
        cell: ({ row }) => <div className="dt-id-cell">{row.getValue("id")}</div>,
    },
    {
        accessorKey: "status",
        size: 140,
        minSize: 120,
        header: "Status",
        cell: ({ row }) => {
            const statuses = row.getValue("status") as JobTableRow["status"]
            const current = Array.isArray(statuses) ? statuses[0] : statuses
            const normalized = current?.toLowerCase()
            const dotClass = normalized === "done" || normalized === "in progress" ? "dt-cell-badge-dot--success"
                : normalized === "failed" || normalized === "error" ? "dt-cell-badge-dot--error"
                    : normalized === "pending" ? "dt-cell-badge-dot--primary"
                        : "dt-cell-badge-dot--muted"
            return (
                <div className="dt-cell-badge">
                    <span className={`dt-cell-badge-dot ${dotClass}`} />
                    <span className="dt-cell-badge-text">{current}</span>
                </div>
            )
        },
    },
    {
        accessorKey: "createdBy",
        size: 160,
        minSize: 140,
        header: "Created By",
        cell: ({ row }) => <div className="dt-cell-text">{row.getValue("createdBy")}</div>,
    },
    {
        accessorKey: "createdAt",
        size: 160,
        minSize: 140,
        header: ({ column }) => {
            const current = column.getIsSorted()
            const Icon = current === "asc" ? IconArrowUp : current === "desc" ? IconArrowDown : IconArrowsSort
            if (!column.getCanSort()) return "Created At"
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
                    Created At
                    <Icon size={16} />
                </button>
            )
        },
        cell: ({ row }) => <div className="dt-cell-text">{row.getValue("createdAt")}</div>,
    },
    {
        accessorKey: "updatedBy",
        size: 160,
        minSize: 140,
        header: "Updated By",
        cell: ({ row }) => <div className="dt-cell-text">{row.getValue("updatedBy")}</div>,
    },
    {
        accessorKey: "updatedAt",
        size: 160,
        minSize: 140,
        header: ({ column }) => {
            const current = column.getIsSorted()
            const Icon = current === "asc" ? IconArrowUp : current === "desc" ? IconArrowDown : IconArrowsSort
            if (!column.getCanSort()) return "Updated At"
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
                    Updated At
                    <Icon size={16} />
                </button>
            )
        },
        cell: ({ row }) => <div className="dt-cell-text">{row.getValue("updatedAt")}</div>,
    },
    {
        accessorKey: "executionMap",
        size: 200,
        minSize: 160,
        header: "Execution Map",
        cell: ({ row }) => <div className="truncate">{row.getValue("executionMap")}</div>,
    },
    {
        accessorKey: "metadata",
        size: 200,
        minSize: 160,
        header: "Metadata",
        cell: ({ row }) => <div className="truncate">{row.getValue("metadata")}</div>,
    },
    {
        id: "actions",
        size: 80,
        minSize: 64,
        enableHiding: false,
        cell: ({ row }) => {
            const job = row.original
            /* v8 ignore start -- @preserve stopPropagation prevents row-select; not reachable in jsdom */
            const stopClick = (e: React.MouseEvent) => e.stopPropagation()
            const stopPointer = (e: React.PointerEvent) => e.stopPropagation()
            const stopKey = (e: React.KeyboardEvent) => e.stopPropagation()
            /* v8 ignore stop -- @preserve */
            return (
                <div className="dt-cell-action">
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            render={<Button variant="icon" icon={<IconDots size={20} />} />}
                            onClick={stopClick}
                            onPointerDown={stopPointer}
                            onKeyDown={stopKey}
                        />
                        <DropdownMenuContent align="end">
                            <DropdownMenuGroup>
                                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                <DropdownMenuItem
                                    onClick={() => navigator.clipboard.writeText(job.id)}
                                >
                                    Copy Job ID
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem>View details</DropdownMenuItem>
                            </DropdownMenuGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )
        },
    },
]
