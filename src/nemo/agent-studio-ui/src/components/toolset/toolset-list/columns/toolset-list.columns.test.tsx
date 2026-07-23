import { fireEvent, render, screen } from "@testing-library/react"
import type { CellContext, ColumnDef, HeaderContext } from "@tanstack/react-table"
import type React from "react"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ToolStatus, ToolsetRow } from "../toolset-list.types"
import { createToolsetTableColumns, toolsetTableColumns } from "./toolset-list.columns"

type SortState = false | "asc" | "desc"

type ColumnStub = {
  getIsSorted: () => SortState
  getCanSort: () => boolean
  toggleSorting: (desc?: boolean) => void
  clearSorting: () => void
}

type RowStub = {
  original: ToolsetRow
  getValue: (key: string) => unknown
}

type TriggerProps = {
  render: ReactElement
  onClick?: (event: React.MouseEvent) => void
  onPointerDown?: (event: React.PointerEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}

const stopPropagationSpy = vi.fn()

function IconMock(): ReactElement {
  return <span data-testid="icon-mock" />
}

vi.mock("@tabler/icons-react", () => ({
  IconDotsVertical: IconMock,
  IconCircleCheck: IconMock,
  IconCircleX: IconMock,
  IconAlertTriangle: IconMock,
  IconLoader2: IconMock,
}))

vi.mock("@/components/data-source/utils/status-icon", () => ({
  StatusIcon: () => <span data-testid="status-icon" />,
}))

vi.mock("@/ui-lib/base-components/button/button", () => ({
  Button: ({
    label,
    icon,
    ...rest
  }: {
    label?: string
    icon?: ReactElement
    variant?: string
    className?: string
  }) => (
    <button type="button" {...rest}>
      {icon}
      {label}
    </button>
  ),
}))

vi.mock("@/ui-lib/base-components/button/button.variants", () => ({
  buttonVariants: () => "btn-variant-mock",
}))

vi.mock("@/ui-lib/base-components/dropdown-menu/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactElement }) => (
    <div data-testid="dropdown-root">{children}</div>
  ),
  DropdownMenuTrigger: ({
    render,
    onClick,
    onPointerDown,
    onKeyDown,
  }: TriggerProps) => {
    onClick?.({ stopPropagation: stopPropagationSpy } as unknown as React.MouseEvent)
    onPointerDown?.({ stopPropagation: stopPropagationSpy } as unknown as React.PointerEvent)
    onKeyDown?.({ stopPropagation: stopPropagationSpy } as unknown as React.KeyboardEvent)

    return <div data-testid="dropdown-trigger">{render}</div>
  },
  DropdownMenuContent: ({ children }: { children: ReactElement }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children: ReactElement[] | ReactElement }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children, onClick }: { children: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

vi.mock("@/ui-lib/base-components/tooltip/tooltip", () => ({
  Tooltip: ({
    content,
    trigger,
  }: {
    content: ReactElement
    trigger: ReactElement
    className?: string
    side?: string
    sideOffset?: number
  }) => (
    <div>
      <div data-testid="tooltip-trigger">{trigger}</div>
      <div data-testid="tooltip-content">{content}</div>
    </div>
  ),
}))

type HeaderCtx = HeaderContext<ToolsetRow, unknown>
type CellCtx = CellContext<ToolsetRow, unknown>

function callHeader(column: ColumnDef<ToolsetRow>, ctx: { column: ColumnStub }): ReactElement | string {
  const header = column.header
  if (typeof header !== "function") {
    throw new Error("Expected column.header to be a function")
  }
  return header(ctx as unknown as HeaderCtx) as ReactElement | string
}

function callCell(column: ColumnDef<ToolsetRow>, ctx: { row?: RowStub }): ReactElement {
  const cell = column.cell
  if (typeof cell !== "function") {
    throw new Error("Expected column.cell to be a function")
  }
  return cell(ctx as unknown as CellCtx) as ReactElement
}

function createColumnStub(current: SortState, canSort = true) {
  const toggleSorting = vi.fn()
  const clearSorting = vi.fn()
  const column: ColumnStub = {
    getIsSorted: () => current,
    getCanSort: () => canSort,
    toggleSorting,
    clearSorting,
  }

  return { column, toggleSorting, clearSorting }
}

function createRow(status: ToolStatus): RowStub {
  const row: ToolsetRow = {
    id: "tool-1",
    name: "Tool A",
    type: "Local",
    status,
    statusDetails: "Status details",
    associatedAgents: "5 agents",
    labels: ["Prod", "EU"],
  }

  return {
    original: row,
    getValue: (key: string) => row[key as keyof ToolsetRow],
  }
}

describe("toolsetTableColumns", () => {
  beforeEach(() => {
    stopPropagationSpy.mockReset()
  })

  it("[tag:toolset-columns] returns plain text header when sorting is disabled", () => {
    const nameColumn = toolsetTableColumns[0]!
    const { column } = createColumnStub(false, false)

    const header = callHeader(nameColumn, { column })

    expect(header).toBe("Name")
  })

  it("[tag:toolset-columns] toggles sorting from unsorted to asc", () => {
    const typeColumn = toolsetTableColumns[1]!
    const { column, toggleSorting } = createColumnStub(false, true)

    render(<>{callHeader(typeColumn, { column })}</>)
    fireEvent.click(screen.getByRole("button", { name: /type/i }))

    expect(toggleSorting).toHaveBeenCalledWith(false)
  })

  it("[tag:toolset-columns] toggles sorting from asc to desc", () => {
    const statusColumn = toolsetTableColumns[2]!
    const { column, toggleSorting } = createColumnStub("asc", true)

    render(<>{callHeader(statusColumn, { column })}</>)
    fireEvent.click(screen.getByRole("button", { name: /status/i }))

    expect(toggleSorting).toHaveBeenCalledWith(true)
  })

  it("[tag:toolset-columns] clears sorting when current is desc", () => {
    const labelsColumn = toolsetTableColumns[4]!
    const { column, clearSorting } = createColumnStub("desc", true)

    render(<>{callHeader(labelsColumn, { column })}</>)
    fireEvent.click(screen.getByRole("button", { name: /labels/i }))

    expect(clearSorting).toHaveBeenCalledTimes(1)
  })

  it("[tag:toolset-columns] renders status tooltip for all status values", () => {
    const statusColumn = toolsetTableColumns[2]!
    const statuses: ToolStatus[] = ["healthy", "unhealthy", "unknown", "deploying"]

    for (const status of statuses) {
      render(<>{callCell(statusColumn, { row: createRow(status) })}</>)
    }

    expect(screen.getAllByText("Healthy").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("Unhealthy").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("Deploying").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("Status details").length).toBeGreaterThanOrEqual(4)
  })

  it("[tag:toolset-columns] omits status message when details are empty", () => {
    const statusColumn = toolsetTableColumns[2]!
    const row: ToolsetRow = {
      ...createRow("healthy").original,
      statusDetails: "",
    }

    render(<>{callCell(statusColumn, { row: { original: row, getValue: (key: string) => row[key as keyof ToolsetRow] } })}</>)

    expect(screen.queryByText("Status details")).not.toBeInTheDocument()
  })

  it("[tag:toolset-columns] default export action stubs are callable", () => {
    const actionsColumn = toolsetTableColumns[5]!
    const row = createRow("healthy")

    render(<>{callCell(actionsColumn, { row })}</>)

    fireEvent.click(screen.getByText("View details"))
    fireEvent.click(screen.getByText("Edit"))
    fireEvent.click(screen.getByText("Delete"))
  })

  it("[tag:toolset-columns] renders associated agents and labels cells", () => {
    const nameColumn = toolsetTableColumns[0]!
    const typeColumn = toolsetTableColumns[1]!
    const associatedAgentsColumn = toolsetTableColumns[3]!
    const labelsColumn = toolsetTableColumns[4]!
    const row = createRow("healthy")
    const { column } = createColumnStub(false, true)

    render(
      <>
        {callHeader(nameColumn, { column })}
        {callCell(nameColumn, { row })}
        {callCell(typeColumn, { row })}
        {callHeader(associatedAgentsColumn, { column })}
        {callCell(associatedAgentsColumn, { row })}
        {callCell(labelsColumn, { row })}
      </>,
    )

    expect(screen.getByRole("button", { name: /name/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /associated agents/i })).toBeInTheDocument()
    expect(screen.getByText("Tool A")).toBeInTheDocument()
    expect(screen.getByText("Local")).toBeInTheDocument()
    expect(screen.getByText("5 agents")).toBeInTheDocument()
    expect(screen.getByText("Prod")).toBeInTheDocument()
    expect(screen.getByText("EU")).toBeInTheDocument()
  })

  it("[tag:toolset-columns] renders actions menu and stops event propagation", () => {
    const actionsColumn = toolsetTableColumns[5]!
    const row = createRow("healthy")

    render(<>{callCell(actionsColumn, { row })}</>)

    expect(screen.getByText("View details")).toBeInTheDocument()
    expect(screen.queryByText("Deprecate")).not.toBeInTheDocument()
    expect(screen.getByText("Edit")).toBeInTheDocument()
    expect(screen.getByText("Delete")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Tool actions for Tool A" })).toBeInTheDocument()
    expect(stopPropagationSpy).toHaveBeenCalledTimes(3)
  })

  it("[tag:toolset-columns] invokes action callbacks from createToolsetTableColumns", () => {
    const onViewDetails = vi.fn()
    const onEdit = vi.fn()
    const onDeprecate = vi.fn()
    const onDelete = vi.fn()
    const columns = createToolsetTableColumns({ onViewDetails, onEdit, onDeprecate, onDelete })
    const nameColumn = columns[0]!
    const actionsColumn = columns[5]!
    const row = createRow("healthy")

    render(<>{callCell(nameColumn, { row })}</>)
    fireEvent.click(screen.getByRole("button", { name: "Tool A" }))
    expect(onViewDetails).toHaveBeenCalledWith("tool-1")

    render(<>{callCell(actionsColumn, { row })}</>)
    fireEvent.click(screen.getByRole("button", { name: "View details" }))
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))

    expect(onViewDetails).toHaveBeenCalledTimes(2)
    expect(onEdit).toHaveBeenCalledWith("tool-1")
    expect(onDelete).toHaveBeenCalledWith("tool-1", "Tool A")
  })
})
