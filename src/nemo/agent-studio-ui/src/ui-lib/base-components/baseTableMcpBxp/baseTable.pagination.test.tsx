import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { BaseTablePagination } from "./baseTable.pagination"

function makeProps(overrides: Partial<Parameters<typeof BaseTablePagination>[0]> = {}) {
  return {
    pageIndex: 0,
    pageCount: 5,
    pageSize: 10,
    totalRows: 50,
    canPreviousPage: false,
    canNextPage: true,
    onFirstPage: vi.fn(),
    onPreviousPage: vi.fn(),
    onNextPage: vi.fn(),
    onLastPage: vi.fn(),
    ...overrides,
  }
}

describe("BaseTablePagination", () => {
  it("renders the range text for first page", () => {
    const { container } = render(<BaseTablePagination {...makeProps()} />)
    const info = container.querySelector(".dt-pagination-info")
    expect(info).toBeInTheDocument()
    expect(info!.textContent).toContain("1")
    expect(info!.textContent).toContain("10")
    expect(info!.textContent).toContain("50")
  })

  it("renders correct range for middle page", () => {
    const { container } = render(<BaseTablePagination {...makeProps({ pageIndex: 2 })} />)
    const info = container.querySelector(".dt-pagination-info")
    expect(info!.textContent).toContain("21")
    expect(info!.textContent).toContain("30")
  })

  it("clamps range end to totalRows on last page", () => {
    const { container } = render(<BaseTablePagination {...makeProps({ pageIndex: 4, totalRows: 45, canNextPage: false })} />)
    const info = container.querySelector(".dt-pagination-info")
    expect(info!.textContent).toContain("41")
    expect(info!.textContent).toContain("45")
  })

  it("renders page number (1-indexed)", () => {
    render(<BaseTablePagination {...makeProps({ pageIndex: 3 })} />)
    expect(screen.getByText("4")).toBeInTheDocument()
  })

  it("disables first/prev buttons on first page", () => {
    render(<BaseTablePagination {...makeProps()} />)
    expect(screen.getByLabelText("Go to first page")).toBeDisabled()
    expect(screen.getByLabelText("Go to previous page")).toBeDisabled()
  })

  it("enables next/last buttons when canNextPage is true", () => {
    render(<BaseTablePagination {...makeProps()} />)
    expect(screen.getByLabelText("Go to next page")).toBeEnabled()
    expect(screen.getByLabelText("Go to last page")).toBeEnabled()
  })

  it("disables next/last buttons on last page", () => {
    render(<BaseTablePagination {...makeProps({ canNextPage: false, canPreviousPage: true })} />)
    expect(screen.getByLabelText("Go to next page")).toBeDisabled()
    expect(screen.getByLabelText("Go to last page")).toBeDisabled()
  })

  it("shows 0 - 0 of 0 when totalRows is zero", () => {
    const { container } = render(
      <BaseTablePagination {...makeProps({ totalRows: 0, pageIndex: 0, canNextPage: false, canPreviousPage: false })} />,
    )
    const info = container.querySelector(".dt-pagination-info")
    expect(info!.textContent).toContain("0 - 0 of 0")
  })

  it("fires navigation callbacks on click", () => {
    const cbs = {
      onFirstPage: vi.fn(),
      onPreviousPage: vi.fn(),
      onNextPage: vi.fn(),
      onLastPage: vi.fn(),
    }
    render(<BaseTablePagination {...makeProps({ pageIndex: 2, canPreviousPage: true, canNextPage: true, ...cbs })} />)

    fireEvent.click(screen.getByLabelText("Go to first page"))
    expect(cbs.onFirstPage).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByLabelText("Go to previous page"))
    expect(cbs.onPreviousPage).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByLabelText("Go to next page"))
    expect(cbs.onNextPage).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByLabelText("Go to last page"))
    expect(cbs.onLastPage).toHaveBeenCalledOnce()
  })
})
