import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { ActionsCell } from "./actions-cell"
import type { ActionMenuItem } from "./actions-cell"

// ---------------------------------------------------------------------------
// Section 4 — ActionsCell
// ---------------------------------------------------------------------------

interface TestRow {
  id: string
  name: string
}

const ROW: TestRow = { id: "row-1", name: "My Source" }

const MENU_ITEMS: ActionMenuItem<TestRow>[] = [
  { label: "Edit", onClick: vi.fn() },
  { label: "Delete", onClick: vi.fn(), className: "danger" },
  { label: "Archive", onClick: vi.fn(), isDisabled: true },
]

describe("ActionsCell", () => {
  // 4.19
  it("[tag:actions-cell][tag:disabled] renders disabled icon button with no dropdown", () => {
    const { container } = renderWithProviders(
      <ActionsCell row={ROW} name={ROW.name} isDisabled menuItems={MENU_ITEMS} />,
    )

    const btn = screen.getByRole("button", { name: `Actions for ${ROW.name}` })
    expect(btn).toBeDisabled()
    // No menu content rendered
    expect(container.querySelector("[role='menu']")).not.toBeInTheDocument()
  })

  // 4.20
  it("[tag:actions-cell] dropdown trigger renders when not disabled", () => {
    renderWithProviders(
      <ActionsCell row={ROW} name={ROW.name} menuItems={MENU_ITEMS} />,
    )

    expect(screen.getByRole("button", { name: `Actions for ${ROW.name}` })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: `Actions for ${ROW.name}` })).not.toBeDisabled()
  })

  // 4.21
  it("[tag:actions-cell] all menu item labels render after opening the dropdown", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <ActionsCell row={ROW} name={ROW.name} menuItems={MENU_ITEMS} />,
    )

    await user.click(screen.getByRole("button", { name: `Actions for ${ROW.name}` }))

    expect(await screen.findByText("Edit")).toBeInTheDocument()
    expect(await screen.findByText("Delete")).toBeInTheDocument()
    expect(await screen.findByText("Archive")).toBeInTheDocument()
  })

  // 4.22
  it("[tag:actions-cell][tag:item-disabled] disabled menu item has aria-disabled", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <ActionsCell row={ROW} name={ROW.name} menuItems={MENU_ITEMS} />,
    )

    await user.click(screen.getByRole("button", { name: `Actions for ${ROW.name}` }))

    const archiveItem = (await screen.findByText("Archive")).closest("[role='menuitem']")!
    expect(archiveItem).toHaveAttribute("aria-disabled", "true")
  })

  // 4.23
  it("[tag:actions-cell] clicking a menu item calls onClick with the row", async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const items: ActionMenuItem<TestRow>[] = [{ label: "Edit", onClick: onEdit }]

    renderWithProviders(
      <ActionsCell row={ROW} name={ROW.name} menuItems={items} />,
    )

    await user.click(screen.getByRole("button", { name: `Actions for ${ROW.name}` }))
    await user.click(await screen.findByText("Edit"))

    expect(onEdit).toHaveBeenCalledWith(ROW, expect.anything())
  })

  // 4.24
  it("[tag:actions-cell] aria-label includes the name prop", () => {
    renderWithProviders(
      <ActionsCell row={ROW} name="My Data Source" menuItems={[]} />,
    )

    expect(
      screen.getByRole("button", { name: "Actions for My Data Source" }),
    ).toBeInTheDocument()
  })
})
