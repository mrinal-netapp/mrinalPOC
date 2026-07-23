import { screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useReactTable, getCoreRowModel, flexRender } from "@tanstack/react-table"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import {
  createPathColumns,
  type PathRow,
} from "./spec-section.folder-paths.columns"

// ---------------------------------------------------------------------------
// createPathColumns
// ---------------------------------------------------------------------------

const ROW: PathRow = { id: "0", path: "/data/volume1" }

function TableWrapper({
  rows,
  onRemove,
}: {
  rows: PathRow[]
  onRemove: (row: PathRow) => void
}): ReactNode {
  const columns = createPathColumns(onRemove)

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <table>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

describe("createPathColumns (folder paths)", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => {
    roCleanup?.()
  })

  it("[tag:path-columns] renders path cell and invokes onRemove from actions menu", async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()

    renderWithProviders(
      <TableWrapper rows={[ROW]} onRemove={onRemove} />,
    )

    expect(screen.getByText("/data/volume1")).toBeInTheDocument()

    const openMenu = screen.getByRole("button", { name: "Actions for /data/volume1" })
    await user.click(openMenu)
    const removeItem = await screen.findByRole("menuitem", { name: "Remove" })
    await user.click(removeItem)

    expect(onRemove).toHaveBeenCalledWith(ROW)
  })
})
