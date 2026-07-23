import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ToolsSelectionTable } from "./toolset-config-dialog.tools-table"
import type { ToolsetTool } from "./configure-dialogs.types"

const TOOLS: ToolsetTool[] = [
  { id: "t2", name: "Beta", description: "second tool" },
  { id: "t1", name: "Alpha", description: "first tool" },
  { id: "t3", name: "Gamma", description: "third widget" },
]

function dataRowNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll(".toolset-config-dialog__tr"),
  ).map(
    (row) =>
      row.querySelector(
        ".toolset-config-dialog__td:not(.toolset-config-dialog__td--checkbox)",
      )?.textContent ?? "",
  )
}

describe("ToolsSelectionTable", () => {
  it("[tag:tools-table] renders the title with the total count and one row per tool", () => {
    const { container } = render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={[]}
        onSelectionChange={vi.fn()}
      />,
    )
    expect(screen.getByText("Tools (3)")).toBeInTheDocument()
    expect(container.querySelectorAll(".toolset-config-dialog__tr")).toHaveLength(3)
  })

  it("[tag:tools-table] shows the default empty message and disables the header checkbox when there are no tools", () => {
    render(
      <ToolsSelectionTable tools={[]} selectedToolIds={[]} onSelectionChange={vi.fn()} />,
    )
    expect(screen.getByText("This toolset exposes no tools.")).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", { name: "Select all tools" }),
    ).toHaveAttribute("data-disabled")
  })

  it("[tag:tools-table] prefers a caller-supplied empty message", () => {
    render(
      <ToolsSelectionTable
        tools={[]}
        selectedToolIds={[]}
        onSelectionChange={vi.fn()}
        emptyMessage="Nothing here"
      />,
    )
    expect(screen.getByText("Nothing here")).toBeInTheDocument()
  })

  it("[tag:tools-table] selecting a row adds its id to the selection", async () => {
    const user = userEvent.setup({ delay: null })
    const onSelectionChange = vi.fn()
    render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    )
    await user.click(screen.getByRole("checkbox", { name: "Select tool Alpha" }))
    expect(onSelectionChange).toHaveBeenCalledWith(["t1"])
  })

  it("[tag:tools-table] deselecting a selected row removes its id", async () => {
    const user = userEvent.setup({ delay: null })
    const onSelectionChange = vi.fn()
    render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={["t1"]}
        onSelectionChange={onSelectionChange}
      />,
    )
    await user.click(screen.getByRole("checkbox", { name: "Select tool Alpha" }))
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it("[tag:tools-table] the header checkbox selects every visible row, preserving off-screen selections", async () => {
    const user = userEvent.setup({ delay: null })
    const onSelectionChange = vi.fn()
    render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={["off-screen"]}
        onSelectionChange={onSelectionChange}
      />,
    )
    await user.click(screen.getByRole("checkbox", { name: "Select all tools" }))
    const next = onSelectionChange.mock.calls[0][0] as string[]
    expect(new Set(next)).toEqual(new Set(["off-screen", "t1", "t2", "t3"]))
  })

  it("[tag:tools-table] the header checkbox deselects visible rows while keeping off-screen selections", async () => {
    const user = userEvent.setup({ delay: null })
    const onSelectionChange = vi.fn()
    render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={["t1", "t2", "t3", "off-screen"]}
        onSelectionChange={onSelectionChange}
      />,
    )
    await user.click(screen.getByRole("checkbox", { name: "Select all tools" }))
    expect(onSelectionChange).toHaveBeenCalledWith(["off-screen"])
  })

  it("[tag:tools-table] shows an indeterminate header state on a partial selection", () => {
    render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={["t1"]}
        onSelectionChange={vi.fn()}
      />,
    )
    expect(
      screen.getByRole("checkbox", { name: "Select all tools" }),
    ).toHaveAttribute("aria-checked", "mixed")
  })

  it("[tag:tools-table] filters rows by name and description, and shows the no-match message", async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={[]}
        onSelectionChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Search tools" }))
    const input = screen.getByLabelText("Search tools")

    await user.type(input, "widget")
    expect(screen.getByText("Gamma")).toBeInTheDocument()
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument()

    await user.clear(input)
    await user.type(input, "zzz")
    expect(screen.getByText("No tools match your search.")).toBeInTheDocument()
  })

  it("[tag:tools-table] closing search clears the query and restores all rows", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={[]}
        onSelectionChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Search tools" }))
    await user.type(screen.getByLabelText("Search tools"), "alpha")
    expect(container.querySelectorAll(".toolset-config-dialog__tr")).toHaveLength(1)

    await user.click(screen.getByRole("button", { name: "Close search" }))
    expect(container.querySelectorAll(".toolset-config-dialog__tr")).toHaveLength(3)
    expect(screen.getByRole("button", { name: "Search tools" })).toBeInTheDocument()
  })

  it("[tag:tools-table] cycles the Name sort through ascending, descending, then unsorted", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={[]}
        onSelectionChange={vi.fn()}
      />,
    )
    const nameHeaderButton = screen.getByRole("button", { name: "Name" })
    const nameHeader = nameHeaderButton.closest("th") as HTMLElement

    // Unsorted: original order.
    expect(dataRowNames(container)).toEqual(["Beta", "Alpha", "Gamma"])

    await user.click(nameHeaderButton)
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending")
    expect(dataRowNames(container)).toEqual(["Alpha", "Beta", "Gamma"])

    await user.click(nameHeaderButton)
    expect(nameHeader).toHaveAttribute("aria-sort", "descending")
    expect(dataRowNames(container)).toEqual(["Gamma", "Beta", "Alpha"])

    await user.click(nameHeaderButton)
    expect(nameHeader).toHaveAttribute("aria-sort", "none")
    expect(dataRowNames(container)).toEqual(["Beta", "Alpha", "Gamma"])
  })

  it("[tag:tools-table] switching the sort column resets to ascending", async () => {
    const user = userEvent.setup({ delay: null })
    const { container } = render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={[]}
        onSelectionChange={vi.fn()}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Name" }))
    await user.click(screen.getByRole("button", { name: "Name" })) // Name desc

    const descHeaderButton = screen.getByRole("button", { name: "Description" })
    await user.click(descHeaderButton)
    const descHeader = descHeaderButton.closest("th") as HTMLElement
    expect(descHeader).toHaveAttribute("aria-sort", "ascending")
    // Sorted by description ascending: "first tool", "second tool", "third widget".
    expect(dataRowNames(container)).toEqual(["Alpha", "Beta", "Gamma"])
  })

  it("[tag:tools-table] marks the selected row with data-selected", () => {
    const { container } = render(
      <ToolsSelectionTable
        tools={TOOLS}
        selectedToolIds={["t1"]}
        onSelectionChange={vi.fn()}
      />,
    )
    const selectedRow = container.querySelector('[data-selected="true"]') as HTMLElement
    expect(within(selectedRow).getByText("Alpha")).toBeInTheDocument()
  })
})
