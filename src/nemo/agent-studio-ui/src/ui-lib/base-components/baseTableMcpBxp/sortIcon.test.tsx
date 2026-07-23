import { render } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import { SortIcon } from "./sortIcon"

describe("SortIcon", () => {
  it("renders two chevrons when direction is false (unsorted)", () => {
    const { container } = render(<SortIcon direction={false} />)
    expect(container.querySelector(".dt-sort-icon--none")).toBeInTheDocument()
    const chevrons = container.querySelectorAll(".dt-sort-chevron")
    expect(chevrons).toHaveLength(2)
  })

  it("renders ascending arrow when direction is 'asc'", () => {
    const { container } = render(<SortIcon direction="asc" />)
    expect(container.querySelector(".dt-sort-icon--asc")).toBeInTheDocument()
    expect(container.querySelector(".dt-sort-arrow")).toBeInTheDocument()
    expect(container.querySelector(".dt-sort-chevron")).toBeNull()
  })

  it("renders descending arrow when direction is 'desc'", () => {
    const { container } = render(<SortIcon direction="desc" />)
    expect(container.querySelector(".dt-sort-icon--desc")).toBeInTheDocument()
    expect(container.querySelector(".dt-sort-arrow")).toBeInTheDocument()
  })

  it("applies custom className to wrapper", () => {
    const { container } = render(<SortIcon direction={false} className="custom" />)
    const wrapper = container.querySelector(".dt-sort-icon-wrapper")
    expect(wrapper).toHaveClass("custom")
  })

  it("does not apply extra class when className is omitted", () => {
    const { container } = render(<SortIcon direction={false} />)
    const wrapper = container.querySelector(".dt-sort-icon-wrapper")
    expect(wrapper?.className).toBe("dt-sort-icon-wrapper")
  })
})
