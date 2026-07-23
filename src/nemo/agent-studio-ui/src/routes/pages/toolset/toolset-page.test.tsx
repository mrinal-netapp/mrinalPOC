import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/toolset", () => ({
  ToolsetList: () => <div data-testid="toolset-list-mock" />,
}))

import { ToolsetPage } from "./toolset-page"

describe("ToolsetPage", () => {
  it("[tag:toolset-page] renders the ToolsetList component", () => {
    render(<ToolsetPage />)

    expect(screen.getByTestId("toolset-list-mock")).toBeInTheDocument()
  })
})
