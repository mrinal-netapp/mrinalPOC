import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"

import { CellMarker } from "./cell-marker"

describe("CellMarker", () => {
  it("[tag:agents-cell] renders its children", () => {
    render(
      <CellMarker isDeprecated={false}>
        <span>cell content</span>
      </CellMarker>,
    )
    expect(screen.getByText("cell content")).toBeInTheDocument()
  })

  it("[tag:agents-cell] applies only the base marker class when not deprecated", () => {
    render(<CellMarker isDeprecated={false}>label</CellMarker>)
    const marker = screen.getByText("label")
    expect(marker).toHaveClass("agent-list-row-marker")
    expect(marker).not.toHaveClass("agent-list-row-marker--deprecated")
  })

  it("[tag:agents-cell] adds the deprecated modifier class when deprecated", () => {
    render(<CellMarker isDeprecated>label</CellMarker>)
    const marker = screen.getByText("label")
    expect(marker).toHaveClass("agent-list-row-marker")
    expect(marker).toHaveClass("agent-list-row-marker--deprecated")
  })
})
