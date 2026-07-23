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
import type { DataSourceRow } from "../baseTable.types"

export const datasourceColumns: ColumnDef<DataSourceRow>[] = [
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
        accessorKey: "name",
        size: 200,
        minSize: 160,
        header: "Name",
        cell: ({ row }) => <div className="dt-cell-text">{row.getValue("name")}</div>,
    },
    {
        accessorKey: "description",
        size: 240,
        minSize: 180,
        header: "Description",
        cell: ({ row }) => <div className="truncate">{row.getValue("description")}</div>,
    },
    {
        accessorKey: "interval",
        size: 140,
        minSize: 120,
        header: "Interval",
        cell: ({ row }) => <div className="dt-cell-text">{row.getValue("interval")}</div>,
    },
    {
        accessorKey: "tags",
        size: 200,
        minSize: 160,
        header: "Tags",
        cell: ({ row }) => {
            const tags = row.getValue("tags") as string[]
            return <div className="truncate">{Array.isArray(tags) ? tags.join(", ") : String(tags)}</div>
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
        accessorKey: "volumes",
        size: 220,
        minSize: 180,
        header: "Volumes",
        cell: ({ row }) => {
            const v = row.getValue("volumes") as unknown
            /* v8 ignore next -- @preserve catch only fires on circular refs / BigInt; safety net for exotic data */
            const s = (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
            return <div className="truncate">{s}</div>
        },
    },
    {
        accessorKey: "filters",
        size: 220,
        minSize: 180,
        header: "Filters",
        cell: ({ row }) => {
            const v = row.getValue("filters") as unknown
            /* v8 ignore next -- @preserve catch only fires on circular refs / BigInt; safety net for exotic data */
            const s = (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
            return <div className="truncate">{s}</div>
        },
    },
    {
        id: "actions",
        size: 80,
        minSize: 64,
        enableHiding: false,
        cell: ({ row }) => {
            const ds = row.original
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
                                    onClick={() => navigator.clipboard.writeText(ds.id)}
                                >
                                    Copy Datasource ID
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
