import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"

// Mock BaseTable to assert props passed to it
vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    isLoading,
    isError,
  }: {
    data: unknown[]
    isLoading: boolean
    isError: boolean
  }) => (
    <div
      data-testid="base-table"
      data-loading={String(isLoading)}
      data-error={String(isError)}
      data-rows={data.length}
    />
  ),
}))

import { DataSourceDetailActivity } from "./data-source-detail-activity"

// ---------------------------------------------------------------------------
// Section 13.1 — DataSourceDetailActivity (placeholder)
// ---------------------------------------------------------------------------

describe("DataSourceDetailActivity", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 13.1
  it("[tag:ds-detail-activity][tag:empty] renders BaseTable with empty row set, isLoading=false, isError=false", () => {
    renderWithProviders(<DataSourceDetailActivity />)

    const table = screen.getByTestId("base-table")
    expect(table).toHaveAttribute("data-loading", "false")
    expect(table).toHaveAttribute("data-error", "false")
    expect(table).toHaveAttribute("data-rows", "0")
  })
})
