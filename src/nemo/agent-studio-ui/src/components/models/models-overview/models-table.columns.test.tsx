import { screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"

import {
  createModelsTableColumns,
  type ModelsTableRow,
  type ModelsTableCallbacks,
} from "./models-table.columns"

const HEALTHY_ROW: ModelsTableRow = {
  id: "gpt-4o",
  model_id: "gpt-4o",
  name: "gpt-4o",
  type: "LLM",
  provider_id: "openai",
  provider_name: "OpenAI",
  provider_model_id: "gpt-4o",
  status: "Active",
  connectionStatus: "Healthy",
  dependentsCount: 3,
  // Custom overrides -> shown directly and no default lookup is triggered.
  inputCostPer1M: 2.5,
  outputCostPer1M: 7.5,
  context_window: 128000,
  version: "2024-08-06",
  description: "Flagship model",
}

const DEGRADED_ROW: ModelsTableRow = { ...HEALTHY_ROW, id: "m2", model_id: "m2", name: "m2", connectionStatus: "Degraded" }
const ERROR_ROW: ModelsTableRow = { ...HEALTHY_ROW, id: "m3", model_id: "m3", name: "m3", connectionStatus: "Error" }
// No connectionStatus → the column falls back to "Disconnected".
const DISCONNECTED_ROW: ModelsTableRow = { ...HEALTHY_ROW, id: "m4", model_id: "m4", name: "m4", connectionStatus: undefined }

function TableWrapper({ rows, callbacks }: { rows: ModelsTableRow[]; callbacks: ModelsTableCallbacks }) {
  const columns = createModelsTableColumns(callbacks)
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  return (
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
  )
}

describe("createModelsTableColumns", () => {
  const makeCallbacks = (): ModelsTableCallbacks => ({
    onNavigateDetail: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  })

  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:models-columns] name cell navigates with the model id", () => {
    const onNavigateDetail = vi.fn()
    renderWithProviders(
      <TableWrapper rows={[HEALTHY_ROW]} callbacks={{ ...makeCallbacks(), onNavigateDetail }} />,
    )

    fireEvent.click(screen.getByRole("button", { name: "gpt-4o" }))
    expect(onNavigateDetail).toHaveBeenCalledWith("gpt-4o")
  })

  it("[tag:models-columns] renders type + provider", () => {
    renderWithProviders(<TableWrapper rows={[HEALTHY_ROW]} callbacks={makeCallbacks()} />)
    expect(screen.getByText("LLM")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("[tag:models-columns] renders each connection-health variant", () => {
    renderWithProviders(
      <TableWrapper
        rows={[HEALTHY_ROW, DEGRADED_ROW, ERROR_ROW, DISCONNECTED_ROW]}
        callbacks={makeCallbacks()}
      />,
    )
    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("Degraded")).toBeInTheDocument()
    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.getByText("Disconnected")).toBeInTheDocument()
  })

  it("[tag:models-columns] renders the row actions trigger", () => {
    renderWithProviders(<TableWrapper rows={[HEALTHY_ROW]} callbacks={makeCallbacks()} />)
    expect(screen.getByRole("button", { name: "Actions for gpt-4o" })).toBeInTheDocument()
  })

  it("[tag:models-columns] renders associated resources count and custom pricing", () => {
    renderWithProviders(<TableWrapper rows={[HEALTHY_ROW]} callbacks={makeCallbacks()} />)
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText("$2.50")).toBeInTheDocument()
    expect(screen.getByText("$7.50")).toBeInTheDocument()
  })

  it("[tag:models-columns] defaults the associated resources count to 0", () => {
    const noDeps: ModelsTableRow = { ...HEALTHY_ROW, dependentsCount: undefined }
    renderWithProviders(<TableWrapper rows={[noDeps]} callbacks={makeCallbacks()} />)
    expect(screen.getByText("0")).toBeInTheDocument()
  })
})
