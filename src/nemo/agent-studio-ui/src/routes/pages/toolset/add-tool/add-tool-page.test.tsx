import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/toolset/add-tool/add-tool", () => ({
  AddTool: () => <div data-testid="add-tool-mock" />,
}))

import { AddToolPage } from "./add-tool-page"

describe("AddToolPage", () => {
  it("[tag:add-tool-page] renders the AddTool component", () => {
    render(<AddToolPage />)

    expect(screen.getByTestId("add-tool-mock")).toBeInTheDocument()
  })
})
