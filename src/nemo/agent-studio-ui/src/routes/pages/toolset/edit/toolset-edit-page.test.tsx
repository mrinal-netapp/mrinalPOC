import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/toolset/edit-tool/edit-tool", () => ({
  EditTool: () => <div data-testid="edit-tool-mock" />,
}))

import { ToolsetEditPage } from "./toolset-edit-page"

describe("ToolsetEditPage", () => {
  it("[tag:toolset-edit-page] renders the EditTool component", () => {
    render(<ToolsetEditPage />)

    expect(screen.getByTestId("edit-tool-mock")).toBeInTheDocument()
  })
})
