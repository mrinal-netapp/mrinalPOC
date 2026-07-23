import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"
import { ChangesCell } from "./changes-cell"

describe("ChangesCell", () => {
  it("[tag:changes-cell] renders 'n/a' when both props are null/undefined", () => {
    renderWithProviders(<ChangesCell />)
    expect(screen.getByText("n/a")).toBeInTheDocument()
  })

  it("[tag:changes-cell] renders 'n/a' when added is null and removed is undefined", () => {
    renderWithProviders(<ChangesCell added={null} />)
    expect(screen.getByText("n/a")).toBeInTheDocument()
  })

  it("[tag:changes-cell] renders 'No changes' when both are 0", () => {
    renderWithProviders(<ChangesCell added={0} removed={0} />)
    expect(screen.getByText("No changes")).toBeInTheDocument()
  })

  it("[tag:changes-cell] renders 'No changes' when added is 0 and removed is null", () => {
    renderWithProviders(<ChangesCell added={0} removed={null} />)
    expect(screen.getByText("No changes")).toBeInTheDocument()
  })

  it("[tag:changes-cell] renders positive added in green", () => {
    renderWithProviders(<ChangesCell added={5} removed={0} />)
    expect(screen.getByText("+5")).toBeInTheDocument()
  })

  it("[tag:changes-cell] renders positive removed in red", () => {
    renderWithProviders(<ChangesCell added={0} removed={3} />)
    expect(screen.getByText("-3")).toBeInTheDocument()
  })

  it("[tag:changes-cell] renders both added and removed", () => {
    renderWithProviders(<ChangesCell added={10} removed={2} />)
    expect(screen.getByText("+10")).toBeInTheDocument()
    expect(screen.getByText("-2")).toBeInTheDocument()
  })
})
