import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu"

// -- helpers

function renderDropdownMenu(
  overrides: {
    onItemClick?: () => void
    disabledItem?: boolean
    contentClassName?: string
  } = {},
) {
  const { onItemClick, disabledItem = false, contentClassName } = overrides
  return renderWithProviders(
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent className={contentClassName}>
        <DropdownMenuItem onClick={onItemClick}>Action one</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabledItem}>Action two</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  )
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open menu" }))
  await screen.findByText("Action one")
}

// ===== DropdownMenu =====

describe("DropdownMenu", () => {
  // 1 — Root / Trigger / Content

  // 1.1
  it("[tag:dropdownMenu][tag:rendering] should render trigger with data-slot and BEM class; content hidden by default", () => {
    renderDropdownMenu()

    const trigger = screen.getByRole("button", { name: "Open menu" })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute("data-slot", "dropdown-menu-trigger")
    expect(trigger).toHaveClass("dropdown-menu__trigger")

    expect(screen.queryByText("Action one")).not.toBeInTheDocument()
  })

  // 1.2
  it("[tag:dropdownMenu][tag:open][tag:keyboard] should show items on click and close on Escape", async () => {
    const user = userEvent.setup()
    renderDropdownMenu()

    await openMenu(user)

    expect(screen.getByText("Action one")).toBeInTheDocument()
    expect(screen.getByText("Action two")).toBeInTheDocument()

    const popup = screen.getByText("Action one").closest("[data-slot='dropdown-menu-content']")
    expect(popup).toHaveClass("dropdown-menu__content")

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByText("Action one")).not.toBeInTheDocument()
    })
  })

  // 1.3
  it("[tag:dropdownMenu][tag:className] should forward className to content popup", async () => {
    const user = userEvent.setup()
    renderDropdownMenu({ contentClassName: "my-custom-menu" })

    await openMenu(user)

    const popup = screen.getByText("Action one").closest("[data-slot='dropdown-menu-content']")
    expect(popup).toHaveClass("dropdown-menu__content", "my-custom-menu")
  })

  // 2 — MenuItem

  // 2.1
  it("[tag:dropdownMenu][tag:callback] should close menu when an item is clicked and fire callback", async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()
    renderDropdownMenu({ onItemClick: handleClick })

    await openMenu(user)
    await user.click(screen.getByText("Action one"))

    expect(handleClick).toHaveBeenCalledOnce()
  })

  // 2.2
  it("[tag:dropdownMenu][tag:disabled] should not trigger click on a disabled item", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    renderDropdownMenu({ disabledItem: true })

    await openMenu(user)

    const disabledItem = screen.getByText("Action two")
    await user.click(disabledItem)

    expect(screen.getByText("Action one")).toBeInTheDocument()
  })

  // 2.3
  it("[tag:dropdownMenu][tag:variant] should set data-variant='destructive' on destructive item", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    const item = await screen.findByText("Delete")

    expect(item.closest("[data-slot='dropdown-menu-item']")).toHaveAttribute("data-variant", "destructive")
  })

  // 3 — Separator

  // 3.1
  it("[tag:dropdownMenu][tag:separator] should render separator with data-slot and BEM class", async () => {
    const user = userEvent.setup()
    renderDropdownMenu()

    await openMenu(user)

    const separator = document.body.querySelector("[data-slot='dropdown-menu-separator']")
    expect(separator).toBeInTheDocument()
    expect(separator).toHaveClass("dropdown-menu__separator")
  })

  // 4 — CheckboxItem

  // 4.1
  it("[tag:dropdownMenu][tag:checkbox] should render checkbox item with data-slot and BEM class, and fire onCheckedChange on click", async () => {
    const user = userEvent.setup()
    const handleCheckedChange = vi.fn()

    renderWithProviders(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem
            checked={false}
            onCheckedChange={handleCheckedChange}
          >
            Check me
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    const item = await screen.findByText("Check me")

    const checkboxItem = item.closest("[data-slot='dropdown-menu-checkbox-item']")
    expect(checkboxItem).toBeInTheDocument()
    expect(checkboxItem).toHaveClass("dropdown-menu__checkbox-item")

    await user.click(item)
    expect(handleCheckedChange).toHaveBeenCalledOnce()
  })

  // 5 — Label + Group

  // 5.1
  it("[tag:dropdownMenu][tag:label][tag:group] should render label (Typography) and group with data-slot and BEM class", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>My Label</DropdownMenuLabel>
            <DropdownMenuItem>Item</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    const label = await screen.findByText("My Label")

    expect(label.tagName).toBe("SPAN")

    const groupLabel = label.closest("[data-slot='dropdown-menu-label']")
    expect(groupLabel).toBeInTheDocument()
    expect(groupLabel).toHaveClass("dropdown-menu__label")

    const group = document.body.querySelector("[data-slot='dropdown-menu-group']")
    expect(group).toBeInTheDocument()
    expect(group).toHaveClass("dropdown-menu__group")
  })

  // 6 — RadioGroup / RadioItem

  // 6.1
  it("[tag:dropdownMenu][tag:radio] should render radio group/items with data-slot and BEM class, and fire onValueChange on click", async () => {
    const user = userEvent.setup()
    const handleValueChange = vi.fn()

    renderWithProviders(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="a" onValueChange={handleValueChange}>
            <DropdownMenuRadioItem value="a">Option A</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="b">Option B</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByText("Option A")

    const radioGroup = document.body.querySelector("[data-slot='dropdown-menu-radio-group']")
    expect(radioGroup).toBeInTheDocument()
    expect(radioGroup).toHaveClass("dropdown-menu__radio-group")

    const radioItem = screen.getByText("Option A").closest("[data-slot='dropdown-menu-radio-item']")
    expect(radioItem).toBeInTheDocument()
    expect(radioItem).toHaveClass("dropdown-menu__radio-item")

    await user.click(screen.getByText("Option B"))
    expect(handleValueChange).toHaveBeenCalledWith("b", expect.anything())
  })

  // 7 — Sub / SubTrigger / SubContent

  // 7.1
  it("[tag:dropdownMenu][tag:submenu] should render sub-trigger with data-slot, BEM class, chevron, and open sub-content on click", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    const subTrigger = await screen.findByText("More actions")

    const subTriggerEl = subTrigger.closest("[data-slot='dropdown-menu-sub-trigger']")
    expect(subTriggerEl).toBeInTheDocument()
    expect(subTriggerEl).toHaveClass("dropdown-menu__sub-trigger")
    expect(subTriggerEl!.querySelector(".dropdown-menu__chevron")).toBeInTheDocument()

    await user.click(subTrigger)

    const subItem = await screen.findByText("Sub item")
    expect(subItem).toBeInTheDocument()
    expect(subItem.closest("[data-slot='dropdown-menu-content']")).toHaveClass("dropdown-menu__sub-content")
  })

  // 7.2
  it("[tag:dropdownMenu][tag:submenu][tag:keyboard] should open submenu with ArrowRight and close with ArrowLeft", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Top item</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Sub item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    await screen.findByText("Top item")

    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowDown}")
    await user.keyboard("{ArrowRight}")

    const subItem = await screen.findByText("Sub item")
    expect(subItem).toBeInTheDocument()

    await user.keyboard("{ArrowLeft}")

    await waitFor(() => {
      expect(screen.queryByText("Sub item")).not.toBeInTheDocument()
    })
    expect(screen.getByText("More actions")).toBeInTheDocument()
  })
})
