import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/toolset/toolset-detail/toolset-detail", () => ({
  ToolsetDetail: () => <div data-testid="toolset-detail-mock" />,
}))

import { ToolsetDetailPage } from "./toolset-detail-page"

describe("ToolsetDetailPage", () => {
  it("[tag:toolset-detail-page] renders the ToolsetDetail component", () => {
    render(<ToolsetDetailPage />)

    expect(screen.getByTestId("toolset-detail-mock")).toBeInTheDocument()
  })
})
