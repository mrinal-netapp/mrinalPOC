import { screen } from "@testing-library/react"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import type { ColumnDef } from "@tanstack/react-table"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { TooltipProvider } from "@/ui-lib/base-components/tooltip/tooltip"

import {
  createProvidersTableColumns,
  providersTableColumns,
  type ProvidersTableRow,
} from "./providers-table.columns"

const HEALTHY_ROW: ProvidersTableRow = {
  id: "openai",
  provider_id: "openai",
  name: "OpenAI",
  status: "Healthy",
  capabilities: "LLM, Embeddings",
  concurrent_requests: 1000,
  buffer_size: 5000,
}

const ERROR_ROW: ProvidersTableRow = {
  ...HEALTHY_ROW,
  id: "self-hosted",
  provider_id: "self-hosted",
  name: "Self-hosted",
  status: "Error",
  statusMessage: "Invalid API key",
}

const DEGRADED_ROW: ProvidersTableRow = {
  ...HEALTHY_ROW,
  id: "azure",
  provider_id: "azure",
  name: "Azure OpenAI",
  status: "Degraded",
}

const DISCONNECTED_ROW: ProvidersTableRow = {
  ...HEALTHY_ROW,
  id: "bedrock",
  provider_id: "bedrock",
  name: "AWS Bedrock",
  status: "Disconnected",
}

function TableWrapper({
  rows,
  columns = providersTableColumns,
}: {
  rows: ProvidersTableRow[]
  columns?: ColumnDef<ProvidersTableRow>[]
}) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <TooltipProvider>
      <table>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TooltipProvider>
  )
}

describe("providersTableColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:providers-columns] renders provider name + capabilities", () => {
    renderWithProviders(<TableWrapper rows={[HEALTHY_ROW]} />)
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("LLM, Embeddings")).toBeInTheDocument()
  })

  it("[tag:providers-columns] renders Healthy status cell", () => {
    renderWithProviders(<TableWrapper rows={[HEALTHY_ROW]} />)
    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })

  it("[tag:providers-columns] renders Error/Degraded/Disconnected status cells", () => {
    renderWithProviders(
      <TableWrapper rows={[ERROR_ROW, DEGRADED_ROW, DISCONNECTED_ROW]} />,
    )
    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.getByText("Degraded")).toBeInTheDocument()
    expect(screen.getByText("Disconnected")).toBeInTheDocument()
  })

  it("[tag:providers-columns] surfaces the status message in a tooltip on hover", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[ERROR_ROW]} />)
    await user.hover(screen.getByText("Error"))
    expect(await screen.findByText("Invalid API key")).toBeInTheDocument()
  })

  it("[tag:providers-columns] formats concurrent requests + buffer size with thousands separators", () => {
    renderWithProviders(<TableWrapper rows={[HEALTHY_ROW]} />)
    expect(screen.getByText("1,000")).toBeInTheDocument()
    expect(screen.getByText("5,000")).toBeInTheDocument()
  })

  it("[tag:providers-columns] exposes an Edit proxy configuration action that fires the callback", async () => {
    const onEditProxy = vi.fn()
    renderWithProviders(
      <TableWrapper
        rows={[HEALTHY_ROW]}
        columns={createProvidersTableColumns({ onEditProxy })}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: "Actions for OpenAI" }))
    await userEvent.click(await screen.findByText("Edit proxy configuration"))

    expect(onEditProxy).toHaveBeenCalledTimes(1)
    expect(onEditProxy).toHaveBeenCalledWith(expect.objectContaining({ provider_id: "openai" }))
  })
})
