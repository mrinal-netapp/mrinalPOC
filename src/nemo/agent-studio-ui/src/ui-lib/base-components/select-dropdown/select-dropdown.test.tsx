import { screen, waitFor, within, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest"
import { renderWithProviders, userEvent } from "@test/render"
import {
  SelectDropdown,
  SelectDropdownRoot,
  SelectDropdownTrigger,
  SelectDropdownGroup,
  SelectDropdownLabel,
  SelectDropdownSeparator,
} from "./select-dropdown"

const ITEMS = [
  { key: "1", value: "apple", label: "Apple" },
  { key: "2", value: "banana", label: "Banana" },
  { key: "3", value: "cherry", label: "Cherry" },
]

function getTrigger(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="select-dropdown-trigger"]')
  if (!el) throw new Error("SelectDropdown trigger not found")
  return el
}

describe("SelectDropdown", () => {
  // ── 6.1 Default rendering ──────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:variant][tag:field] should render placeholder, Field wrapper class and chevron icon by default", () => {
    // Execute
    const { container } = renderWithProviders(<SelectDropdown items={ITEMS} />)

    // Validate
    expect(screen.getByText("Select...")).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-wrapper--field")).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-chevron")).toBeInTheDocument()
  })

  // ── 6.2 Label, optional, tooltip ──────────────────────────────────────────

  it("[tag:select-dropdown] should render the label text in the header when label prop is provided", () => {
    // Execute
    renderWithProviders(<SelectDropdown items={ITEMS} label="Fruit" />)

    // Validate
    expect(screen.getByText("Fruit")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:optional] should render Optional badge when isOptional is true", () => {
    // Execute
    renderWithProviders(
      <SelectDropdown items={ITEMS} label="Fruit" options={{ isOptional: true }} />,
    )

    // Validate
    expect(screen.getByText("Optional")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:tooltip] should render the tooltip info icon when tooltip prop is provided", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} tooltip="Helpful hint" />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-header-tooltip-icon")).toBeInTheDocument()
  })

  // ── 6.3 Single select -- uncontrolled ─────────────────────────────────────

  it("[tag:select-dropdown] should display selected item label in trigger after selecting an item in uncontrolled mode", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} onValueChange={onValueChange} />,
    )

    // Execute
    await user.click(getTrigger(container))
    // Items render in a portal — screen searches the full document body
    await user.click(await screen.findByRole("option", { name: "Apple" }))

    // Validate — scope to container to avoid matching the portal item label
    await waitFor(() => {
      expect(within(container).getByText("Apple")).toBeInTheDocument()
    })
    expect(onValueChange).toHaveBeenCalledWith("apple", expect.anything())
  })

  // ── 6.4 Single select -- controlled ───────────────────────────────────────

  it("[tag:select-dropdown][tag:controlled] should display the label matching the value prop in controlled mode", () => {
    // Execute
    const { container } = renderWithProviders(<SelectDropdown items={ITEMS} value="banana" />)

    // Validate — use within(container) to scope away from portal items
    expect(within(container).getByText("Banana")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:controlled] should update the displayed label when value prop changes in controlled mode", () => {
    // Setup
    const { container, rerender } = renderWithProviders(<SelectDropdown items={ITEMS} value="banana" />)
    expect(within(container).getByText("Banana")).toBeInTheDocument()

    // Execute
    rerender(<SelectDropdown items={ITEMS} value="cherry" />)

    // Validate — scope to container to avoid matching portal item labels
    expect(within(container).getByText("Cherry")).toBeInTheDocument()
  })

  // ── 6.5 Multi select -- basic ─────────────────────────────────────────────

  it("[tag:select-dropdown][tag:multi-select] should show N selected text and call onValueChange with an array when multiple items are selected", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        onValueChange={onValueChange}
        options={{ isMultiSelect: true }}
      />,
    )

    // Execute
    await user.click(getTrigger(container))
    await user.click(await screen.findByText("Apple"))
    await user.click(await screen.findByText("Banana"))

    // Validate
    await waitFor(() => {
      expect(screen.getByText("2 selected")).toBeInTheDocument()
      expect(onValueChange).toHaveBeenLastCalledWith(
        expect.arrayContaining(["apple", "banana"]),
        expect.anything(),
      )
    })
  })

  // ── 6.6 Multi select -- chip display ──────────────────────────────────────

  // ChipList (rendered when values are selected) uses ResizeObserver; stub it
  // only for the tests that actually mount chips to avoid affecting other tests.
  describe("with chip display and selected values", () => {
    beforeAll(() => {
      vi.stubGlobal("ResizeObserver", class {
        observe(): void { }
        unobserve(): void { }
        disconnect(): void { }
      })
    })

    afterAll(() => {
      vi.unstubAllGlobals()
    })

    it("[tag:select-dropdown][tag:multi-select][tag:chip][tag:chip-list] should render a chip for each selected value in chip display mode", () => {
      // Execute
      renderWithProviders(
        <SelectDropdown
          items={ITEMS}
          value={["apple", "banana"]}
          variant="field"
          options={{ isMultiSelect: true, isChipDisplay: true }}
        />,
      )

      // Validate
      expect(screen.getByText("Apple")).toBeInTheDocument()
      expect(screen.getByText("Banana")).toBeInTheDocument()
    })

    it("[tag:select-dropdown][tag:multi-select][tag:chip][tag:chip-list] should call onValueChange with the item removed when a chip remove button is clicked", async () => {
      // Setup
      const user = userEvent.setup()
      const onValueChange = vi.fn()
      renderWithProviders(
        <SelectDropdown
          items={ITEMS}
          value={["apple", "banana"]}
          onValueChange={onValueChange}
          variant="field"
          options={{ isMultiSelect: true, isChipDisplay: true }}
        />,
      )

      // Execute
      const removeBtn = screen.getByRole("button", { name: "Remove Apple" })
      await user.click(removeBtn)

      // Validate
      expect(onValueChange).toHaveBeenCalledWith(["banana"], undefined)
    })

    it("[tag:select-dropdown][tag:multi-select][tag:chip][tag:chip-list][tag:readonly] should display chip labels using the raw value string when the value has no matching item in the list", () => {
      // Execute — values not present in items so getLabel falls back to String(v)
      renderWithProviders(
        <SelectDropdown
          items={[]}
          value={["mango", "papaya"]}
          variant="field"
          options={{ isMultiSelect: true, isChipDisplay: true, isReadOnly: true }}
        />,
      )

      // Validate — chip labels are the raw value strings since no item match exists
      expect(screen.getByText("mango")).toBeInTheDocument()
      expect(screen.getByText("papaya")).toBeInTheDocument()
    })

    it("[tag:select-dropdown][tag:multi-select][tag:chip][tag:chip-list] should treat a non-array value as empty and show placeholder in chip display mode", () => {
      // Execute — passing a string instead of array hits the empty-array fallback branch
      renderWithProviders(
        <SelectDropdown
          items={ITEMS}
          value={"apple" as unknown as string[]}
          variant="field"
          options={{ isMultiSelect: true, isChipDisplay: true }}
        />,
      )

      // Validate — non-array value is coerced to [] so placeholder is shown
      expect(screen.getByText("Select...")).toBeInTheDocument()
    })
  })

  it("[tag:select-dropdown][tag:multi-select][tag:chip][tag:chip-list] should show placeholder in chip display mode when no values are selected", () => {
    // Execute
    renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        value={[]}
        variant="field"
        options={{ isMultiSelect: true, isChipDisplay: true }}
      />,
    )

    // Validate
    expect(screen.getByText("Select...")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:trigger] should display the raw value string in the trigger when the controlled value does not match any item", () => {
    // Setup — value "unknown" is not in ITEMS so ?.label is undefined and ?? String(values) is used
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} value="unknown" />,
    )

    // Validate — trigger shows the raw value string as fallback
    expect(getTrigger(container)).toHaveTextContent("unknown")
  })

  // ── 6.7 chip removal (covered in nested describe above) ───────────────────

  // ── 6.8 Clear button ──────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:clearable][tag:button] should show the clear button and call onValueChange with null when clicked in single select mode", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        value="apple"
        onValueChange={onValueChange}
        options={{ isClearable: true }}
      />,
    )

    // Validate — clear button is visible when a value is selected (inside aria-hidden overlay)
    const clearBtn = screen.getByRole("button", { name: "Clear selection", hidden: true })
    expect(clearBtn).toBeInTheDocument()

    // Execute
    await user.click(clearBtn)

    // Validate — callback receives null
    expect(onValueChange).toHaveBeenCalledWith(null, undefined)
  })

  it("[tag:select-dropdown][tag:multi-select][tag:clearable][tag:button] should call onValueChange with empty array when clear button is clicked in multi select mode", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        value={["apple", "banana"]}
        onValueChange={onValueChange}
        options={{ isClearable: true, isMultiSelect: true }}
      />,
    )

    // Execute
    const clearBtn = screen.getByRole("button", { name: "Clear selection", hidden: true })
    await user.click(clearBtn)

    // Validate
    expect(onValueChange).toHaveBeenCalledWith([], undefined)
  })

  it("[tag:select-dropdown][tag:clearable][tag:button] should not show clear button when there is no selected value", () => {
    // Execute
    renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isClearable: true }} />,
    )

    // Validate
    expect(
      screen.queryByRole("button", { name: "Clear selection", hidden: true }),
    ).not.toBeInTheDocument()
  })

  // ── 6.9 Disabled state ────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:disabled] should disable the trigger when the disabled prop is set", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} disabled />,
    )

    // Validate
    expect(getTrigger(container)).toBeDisabled()
  })

  // ── 6.10 Read-only state ──────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:readonly] should mark the trigger as readonly when options.isReadOnly is true", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isReadOnly: true }} />,
    )

    // Validate
    const trigger = getTrigger(container)
    expect(trigger).toHaveAttribute("aria-readonly", "true")
    expect(trigger).toHaveAttribute("data-readonly", "true")
    expect(trigger).toHaveAttribute("tabindex", "-1")
  })

  it("[tag:select-dropdown][tag:readonly] should not fire onOpenChange when isReadOnly is true", () => {
    const spy = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isReadOnly: true }} onOpenChange={spy} />,
    )

    fireEvent.click(getTrigger(container))
    expect(spy).not.toHaveBeenCalled()
  })

  // ── 6.11 Error message ────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:error] should render the error footer with message text and error modifier class when error prop is provided", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} error="Something went wrong" />,
    )

    // Validate
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-footer--error")).toBeInTheDocument()
  })

  // ── 6.12 Warning message ──────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:warning] should render the warning footer with message text and warning modifier class when warning prop is provided", () => {
    // Execute
    const { container } = renderWithProviders(<SelectDropdown items={ITEMS} warning="Check this" />)

    // Validate
    expect(screen.getByText("Check this")).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-footer--warning")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:error][tag:warning] should show only the error footer and hide the warning when both error and warning props are provided", () => {
    // Execute
    renderWithProviders(<SelectDropdown items={ITEMS} error="Err msg" warning="Warn msg" />)

    // Validate
    expect(screen.getByText("Err msg")).toBeInTheDocument()
    expect(screen.queryByText("Warn msg")).not.toBeInTheDocument()
  })

  // ── 6.13 Underline variant ────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:variant][tag:underline] should apply underline wrapper class when variant is Underline", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-wrapper--underline")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline] should display label: value format in the trigger when variant is Underline and label is provided", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" label="Fruit" value="apple" />,
    )

    // Validate — scope to container to avoid matching portal item labels
    expect(within(container).getByText("Fruit: Apple")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline] should display only the value in the trigger when variant is Underline and no label is provided", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" value="apple" />,
    )

    // Validate
    expect(within(container).getByText("Apple")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline][tag:tooltip] should render the tooltip icon inline in the underline row when variant is Underline", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" tooltip="Hint" />,
    )

    // Validate — tooltip icon lives inside the underline-row (not in a header)
    const row = container.querySelector(".select-dropdown-underline-row")
    expect(row?.querySelector(".select-dropdown-header-tooltip-icon")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline] should display label prefix and placeholder span when variant is Underline with a label and no value selected", () => {
    // Execute — Underline + label provided + no value (isPlaceholder=true branch with label)
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" label="Fruit" />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-underline-label-prefix")).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-placeholder")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline][tag:warning] should apply warning modifier class to the Underline wrapper when warning prop is provided", () => {
    // Execute — Underline variant with warning and no error
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" warning="Please review" />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-wrapper--warning")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline][tag:disabled] should apply disabled modifier class to the Underline wrapper when disabled prop is set", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" disabled />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-wrapper--disabled")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline][tag:readonly] should apply readonly modifier class to the Underline wrapper when isReadOnly is true", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" options={{ isReadOnly: true }} />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-wrapper--readonly")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:variant][tag:underline][tag:error] should apply error modifier class to the Underline wrapper when error prop is provided", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} variant="underline" error="Something went wrong" />,
    )

    // Validate
    expect(container.querySelector(".select-dropdown-wrapper--error")).toBeInTheDocument()
  })

  // ── 6.14 Search bar ───────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:search] should filter items matching the search query when text is typed in the search input", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isSearchable: true }} />,
    )

    // Execute — open dropdown then type "an" which matches only Banana
    await user.click(getTrigger(container))
    await user.type(await screen.findByRole("textbox"), "an")

    // Validate — only 1 option matches; the other 2 are removed from the DOM
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(1)
    })
    expect(screen.getByRole("option", { name: "Banana" })).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:search] should restore all items when the search input is cleared", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isSearchable: true }} />,
    )

    // Execute
    await user.click(getTrigger(container))
    const searchInput = await screen.findByRole("textbox")
    await user.type(searchInput, "an")
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1))
    await user.clear(searchInput)

    // Validate
    await waitFor(() => {
      expect(screen.getAllByRole("option")).toHaveLength(ITEMS.length)
    })
  })

  // ── 6.15 Search bar -- clear button ───────────────────────────────────────

  it("[tag:select-dropdown][tag:search][tag:button] should empty the search input when the clear search button is clicked", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isSearchable: true }} />,
    )

    // Execute
    await user.click(getTrigger(container))
    const searchInput = await screen.findByRole("textbox")
    await user.type(searchInput, "ban")
    await user.click(screen.getByRole("button", { name: "Clear search" }))

    // Validate
    expect(searchInput).toHaveValue("")
  })

  it("[tag:select-dropdown][tag:search][tag:disabled] should apply the disabled class to the searchbar when disabled and isSearchable are both set", async () => {
    // Setup — open prop forces the popup to mount while disabled=true, so the searchbar
    // renders with isDisabled=true and hits the truthy && branch
    renderWithProviders(
      <SelectDropdown items={ITEMS} disabled open options={{ isSearchable: true }} />,
    )

    // Validate — searchbar carries the disabled modifier class
    await waitFor(() => {
      expect(document.body.querySelector(".select-dropdown-searchbar--disabled")).toBeInTheDocument()
    })
  })

  // ── 6.16 Add new item ─────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:search][tag:add-new][tag:button] should call onAddNew with trimmed text when Add button is clicked with a unique search value", async () => {
    // Setup
    const user = userEvent.setup()
    const onAddNew = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        onAddNew={onAddNew}
        options={{ isSearchable: true, canAddNew: true }}
      />,
    )

    // Execute
    await user.click(getTrigger(container))
    await user.type(await screen.findByRole("textbox"), "Mango")
    await user.click(screen.getByRole("button", { name: "Add new item" }))

    // Validate
    expect(onAddNew).toHaveBeenCalledWith("Mango")
  })

  it("[tag:select-dropdown][tag:search][tag:add-new][tag:button] should disable the Add button when the search text matches an existing item label", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        options={{ isSearchable: true, canAddNew: true }}
      />,
    )

    // Execute
    await user.click(getTrigger(container))
    await user.type(await screen.findByRole("textbox"), "Apple")

    // Validate
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add new item" })).toBeDisabled()
    })
  })

  it("[tag:select-dropdown][tag:search][tag:add-new][tag:button] should disable the Add button when the search input is empty", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        options={{ isSearchable: true, canAddNew: true }}
      />,
    )

    // Execute — open dropdown without typing anything
    await user.click(getTrigger(container))
    await screen.findByRole("textbox")

    // Validate — no text typed, Add button must be disabled
    expect(screen.getByRole("button", { name: "Add new item" })).toBeDisabled()
  })

  it("[tag:select-dropdown][tag:search][tag:add-new][tag:button] should clear the search input after clicking Add when onAddNew handler is not provided", async () => {
    // Setup — canAddNew: true without an onAddNew handler (covers the onAddNew?.() undefined branch)
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        options={{ isSearchable: true, canAddNew: true }}
      />,
    )

    // Execute — open dropdown, type a unique value, click Add
    await user.click(getTrigger(container))
    const searchInput = await screen.findByPlaceholderText("Search or add...")
    await user.type(searchInput, "Mango")
    await user.click(screen.getByRole("button", { name: "Add new item" }))

    // Validate — search is cleared even though onAddNew was not provided
    expect(searchInput).toHaveValue("")
  })

  // ── 6.17 Select all ───────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:multi-select][tag:select-all] should call onValueChange with all item values when Select All is clicked and none are selected", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        onValueChange={onValueChange}
        options={{ isMultiSelect: true, isSelectAllEnabled: true }}
      />,
    )

    // Execute
    await user.click(getTrigger(container))
    await user.click(await screen.findByRole("button", { name: "Select all" }))

    // Validate
    expect(onValueChange).toHaveBeenCalledWith(
      expect.arrayContaining(["apple", "banana", "cherry"]),
      undefined,
    )
  })

  it("[tag:select-dropdown][tag:multi-select][tag:select-all] should call onValueChange with all item values when Select All is clicked while some items are already selected", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        value={["apple"]}
        onValueChange={onValueChange}
        options={{ isMultiSelect: true, isSelectAllEnabled: true }}
      />,
    )

    // Execute
    await user.click(getTrigger(container))
    // checkboxState = "some" → aria-label is "Select all"
    await user.click(await screen.findByRole("button", { name: "Select all" }))

    // Validate
    expect(onValueChange).toHaveBeenCalledWith(
      expect.arrayContaining(["apple", "banana", "cherry"]),
      undefined,
    )
  })

  it("[tag:select-dropdown][tag:multi-select][tag:select-all] should call onValueChange with an empty array when Select All is clicked while all items are selected", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        value={["apple", "banana", "cherry"]}
        onValueChange={onValueChange}
        options={{ isMultiSelect: true, isSelectAllEnabled: true }}
      />,
    )

    // Execute
    await user.click(getTrigger(container))
    // checkboxState = "all" → aria-label is "Deselect all"
    await user.click(await screen.findByRole("button", { name: "Deselect all" }))

    // Validate
    expect(onValueChange).toHaveBeenCalledWith([], undefined)
  })

  it("[tag:select-dropdown][tag:multi-select][tag:select-all] should apply the list--with-items class when items are empty but isSelectAllEnabled is true", async () => {
    // Setup — empty items + selectAll: the right side of || (isMultiSelect && isSelectAllEnabled)
    // is evaluated only when filteredItems.length === 0
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={[]}
        options={{ isMultiSelect: true, isSelectAllEnabled: true }}
      />,
    )

    // Execute — open dropdown to render the list
    await user.click(getTrigger(container))

    // Validate — the list has the --with-items class because isSelectAllEnabled is true
    await waitFor(() => {
      expect(document.body.querySelector(".select-dropdown-list--with-items")).toBeInTheDocument()
    })
  })

  // ── 6.18 Empty state ──────────────────────────────────────────────────────

  it("[tag:select-dropdown] should display the default empty message when items array is empty", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(<SelectDropdown items={[]} />)

    // Execute
    await user.click(getTrigger(container))

    // Validate
    expect(await screen.findByText("No options available")).toBeInTheDocument()
  })

  it("[tag:select-dropdown] should display a custom empty message when emptyMessage prop is provided and items array is empty", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={[]} emptyMessage="Nothing here" />,
    )

    // Execute
    await user.click(getTrigger(container))

    // Validate
    expect(await screen.findByText("Nothing here")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:search] should display the empty message when a search query matches no items", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isSearchable: true }} />,
    )

    // Execute
    await user.click(getTrigger(container))
    await user.type(await screen.findByRole("textbox"), "zzz")

    // Validate
    await waitFor(() => {
      expect(screen.getByText("No options available")).toBeInTheDocument()
    })
  })

  // ── 6.19 Disabled items ───────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:disabled] should not call onValueChange when a disabled item is clicked", async () => {
    // Setup
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    const itemsWithDisabled = [
      { key: "1", value: "apple", label: "Apple", isDisabled: true },
      { key: "2", value: "banana", label: "Banana" },
    ]
    const { container } = renderWithProviders(
      <SelectDropdown items={itemsWithDisabled} onValueChange={onValueChange} />,
    )

    // Execute — open dropdown, then dispatch click directly to bypass pointer-events:none
    // that Base UI applies to disabled Combobox.Item elements
    await user.click(getTrigger(container))
    const disabledOption = await screen.findByRole("option", { name: "Apple" })

    // Validate aria-disabled is set by Base UI
    expect(disabledOption).toHaveAttribute("aria-disabled", "true")

    // Use fireEvent to bypass pointer-events:none and confirm Base UI blocks selection
    fireEvent.click(disabledOption)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  // ── 6.20 Custom renderCell ────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:render-cell] should use the renderCell function to render custom content for each item", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        renderCell={(item) => (
          <span data-testid={`custom-cell-${item.key}`}>{item.label} (custom)</span>
        )}
      />,
    )

    // Execute
    await user.click(getTrigger(container))

    // Validate
    expect(await screen.findByTestId("custom-cell-1")).toBeInTheDocument()
    expect(screen.getByText("Apple (custom)")).toBeInTheDocument()
    expect(screen.getByTestId("custom-cell-2")).toBeInTheDocument()
    expect(screen.getByTestId("custom-cell-3")).toBeInTheDocument()
  })

  // ── 6.21 Size variants ────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:variant][tag:small][tag:medium][tag:large] should apply the correct wrapper class for each size variant", () => {
    // small
    const { container: small } = renderWithProviders(<SelectDropdown items={ITEMS} size="small" />)
    expect(small.querySelector(".select-dropdown-wrapper--small")).toBeInTheDocument()

    // medium
    const { container: medium } = renderWithProviders(<SelectDropdown items={ITEMS} size="medium" />)
    expect(medium.querySelector(".select-dropdown-wrapper--medium")).toBeInTheDocument()

    // large
    const { container: large } = renderWithProviders(<SelectDropdown items={ITEMS} size="large" />)
    expect(large.querySelector(".select-dropdown-wrapper--large")).toBeInTheDocument()
  })

  // ── 6.22 Loading state ────────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:loading][tag:loader] should show the FlashingDotsLoader and disable the trigger when isLoading is true", () => {
    // Execute
    const { container } = renderWithProviders(<SelectDropdown items={ITEMS} isLoading={true} />)

    // Validate — loader replaces chevron (icons overlay is aria-hidden so we use querySelector)
    expect(container.querySelector('[role="status"]')).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-chevron")).not.toBeInTheDocument()
    expect(getTrigger(container)).toBeDisabled()
  })

  // ── 6.23 Searchbar loading ────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:loading][tag:loader][tag:search][tag:add-new] should show loader and hide Add button in search bar when isSearchbarLoading is true", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        options={{ isSearchable: true, canAddNew: true, isSearchbarLoading: true }}
        onAddNew={vi.fn()}
      />,
    )

    // Execute — open the dropdown
    await user.click(getTrigger(container))

    // Validate — Add button is gone, loader is present in the searchbar
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Add new item" })).not.toBeInTheDocument()
      expect(screen.getByRole("status")).toBeInTheDocument()
    })
  })

  // ── 6.24 defaultValue (uncontrolled) ──────────────────────────────────────

  it("[tag:select-dropdown][tag:uncontrolled] should display the label matching defaultValue in uncontrolled mode", () => {
    // Execute
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} defaultValue="apple" />,
    )

    // Validate
    expect(getTrigger(container)).toHaveTextContent("Apple")
  })

  it("[tag:select-dropdown][tag:uncontrolled][tag:clearable][tag:button] should reset to placeholder after clearing when defaultValue is set in uncontrolled mode", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} defaultValue="apple" options={{ isClearable: true }} />,
    )
    expect(getTrigger(container)).toHaveTextContent("Apple")

    // Execute — clear button is inside aria-hidden overlay so query by class
    await user.click(container.querySelector<HTMLElement>(".select-dropdown-clear")!)

    // Validate — resets to placeholder
    expect(getTrigger(container)).toHaveTextContent("Select...")
  })

  // ── 6.25 Sub-components ───────────────────────────────────────────────────

  it("[tag:select-dropdown][tag:sub-components] should render SelectDropdownGroup, SelectDropdownLabel and SelectDropdownSeparator with correct data-slot attributes and classes", () => {
    // Execute — Group, Label, and Separator do not need Combobox item-collection context
    const { container } = renderWithProviders(
      <SelectDropdownRoot>
        <SelectDropdownGroup>
          <SelectDropdownLabel>Section A</SelectDropdownLabel>
        </SelectDropdownGroup>
        <SelectDropdownSeparator />
      </SelectDropdownRoot>,
    )

    // Validate
    expect(container.querySelector('[data-slot="select-dropdown-group"]')).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-group")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="select-dropdown-label"]')).toBeInTheDocument()
    expect(container.querySelector(".select-dropdown-label")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="select-dropdown-separator"]')).toBeInTheDocument()
    expect(screen.getByText("Section A")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:sub-components] should render the chevron icon inside SelectDropdownTrigger when hideChevron is false", () => {
    // Execute — SelectDropdownTrigger defaults to hideChevron=false
    const { container } = renderWithProviders(
      <SelectDropdownRoot>
        <SelectDropdownTrigger />
      </SelectDropdownRoot>,
    )

    // Validate — chevron renders inside the trigger itself (not the outer overlay)
    expect(container.querySelector('[data-slot="select-dropdown-trigger"] .select-dropdown-trigger-icon')).toBeInTheDocument()
  })

  // ── 6.26 Keyboard -- Enter to add ─────────────────────────────────────────

  it("[tag:select-dropdown][tag:search][tag:add-new][tag:button][tag:keyboard] should call onAddNew when Enter is pressed with a unique search value", async () => {
    // Setup
    const user = userEvent.setup()
    const onAddNew = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        options={{ isSearchable: true, canAddNew: true }}
        onAddNew={onAddNew}
      />,
    )

    // Execute — open dropdown, type a unique value, press Enter
    await user.click(getTrigger(container))
    const searchInput = await screen.findByPlaceholderText("Search or add...")
    await user.type(searchInput, "Dragonfruit")
    await user.keyboard("{Enter}")

    // Validate
    expect(onAddNew).toHaveBeenCalledWith("Dragonfruit")
  })

  it("[tag:select-dropdown][tag:search][tag:add-new][tag:button][tag:keyboard] should not call onAddNew when Enter is pressed with a search value that matches an existing item", async () => {
    // Setup — canAdd is false when search matches an existing label
    const user = userEvent.setup()
    const onAddNew = vi.fn()
    const { container } = renderWithProviders(
      <SelectDropdown
        items={ITEMS}
        options={{ isSearchable: true, canAddNew: true }}
        onAddNew={onAddNew}
      />,
    )

    // Execute — type an existing item label then press Enter
    await user.click(getTrigger(container))
    const searchInput = await screen.findByPlaceholderText("Search or add...")
    await user.type(searchInput, "Apple")
    await user.keyboard("{Enter}")

    // Validate — canAdd was false so onAddNew is never called
    expect(onAddNew).not.toHaveBeenCalled()
  })

  // ── 6.27 Checkbox display and multiline sublabel ──────────────────────────

  it("[tag:select-dropdown][tag:checkbox] should render checkbox icons inside item cells when cellHasCheckbox is true", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ cellHasCheckbox: true }} />,
    )

    // Execute — open the dropdown
    await user.click(getTrigger(container))

    // Validate — items render in a portal so query document.body, not container
    await waitFor(() => {
      const checkboxes = document.body.querySelectorAll(".select-dropdown-item-cell__checkbox")
      expect(checkboxes.length).toBeGreaterThan(0)
    })
  })

  it("[tag:select-dropdown][tag:multiline] should render the sublabel inside item cells when isCellMultiline is true and item has a sublabel", async () => {
    // Setup
    const user = userEvent.setup()
    const itemsWithSublabel = [
      { key: "1", value: "apple", label: "Apple", sublabel: "A sweet fruit" },
      { key: "2", value: "banana", label: "Banana" },
    ]
    const { container } = renderWithProviders(
      <SelectDropdown items={itemsWithSublabel} options={{ isCellMultiline: true }} />,
    )

    // Execute — open the dropdown
    await user.click(getTrigger(container))

    // Validate
    await waitFor(() => {
      expect(screen.getByText("A sweet fruit")).toBeInTheDocument()
    })
  })

  // ── 6.28 onOpenChange resets search ───────────────────────────────────────

  it("[tag:select-dropdown][tag:search] should reset the search query and show all items when the dropdown is closed and reopened", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isSearchable: true }} />,
    )

    // Execute — open, type a query that filters items
    await user.click(getTrigger(container))
    const searchInput = await screen.findByPlaceholderText("Search...")
    await user.type(searchInput, "App")
    await waitFor(() => expect(screen.queryByText("Banana")).not.toBeInTheDocument())

    // Close the dropdown
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument())

    // Reopen — search should be cleared and all items visible
    await user.click(getTrigger(container))
    await waitFor(() => {
      expect(screen.getByText("Banana")).toBeInTheDocument()
      expect(screen.getByText("Cherry")).toBeInTheDocument()
    })
  })

  // ── 6.29 Escape key in search ─────────────────────────────────────────────

  it("[tag:select-dropdown][tag:search][tag:keyboard] should close the dropdown when Escape is pressed in the search input", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown items={ITEMS} options={{ isSearchable: true }} />,
    )

    // Execute — open the dropdown and focus the search input
    await user.click(getTrigger(container))
    const searchInput = await screen.findByPlaceholderText("Search...")
    await user.click(searchInput)

    // Press Escape — it should propagate up to Base UI which closes the popup
    await user.keyboard("{Escape}")

    // Validate — dropdown is closed
    await waitFor(() => {
      expect(screen.queryByRole("option")).not.toBeInTheDocument()
    })
  })

  // ── 6.30 Grouped items ────────────────────────────────────────────────────

  const GROUPS = [
    {
      key: "llm",
      label: "LLM",
      items: [
        { key: "1", value: "gpt-4o", label: "GPT-4o" },
        { key: "2", value: "gpt-3.5", label: "GPT-3.5" },
      ],
    },
    {
      key: "embedding",
      label: "Embedding",
      items: [{ key: "3", value: "embed-3", label: "Text Embedding 3" }],
    },
  ]

  it("[tag:select-dropdown][tag:groups] should render a section heading and its options for each group", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown groups={GROUPS} options={{ isMultiSelect: true }} />,
    )

    // Execute
    await user.click(getTrigger(container))

    // Validate — both group headings and their options render in the portal
    expect(await screen.findByText("LLM")).toBeInTheDocument()
    expect(screen.getByText("Embedding")).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "GPT-4o" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Text Embedding 3" })).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:groups][tag:controlled] should resolve the trigger label across groups for a selected value", () => {
    // Execute — the selected value lives in the second group
    const { container } = renderWithProviders(
      <SelectDropdown groups={GROUPS} value="embed-3" />,
    )

    // Validate — flattening across groups resolves the label
    expect(within(container).getByText("Text Embedding 3")).toBeInTheDocument()
  })

  it("[tag:select-dropdown][tag:groups][tag:search] should hide a group whose items do not match the search query", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown groups={GROUPS} options={{ isSearchable: true }} />,
    )

    // Execute — "gpt" matches only the LLM group's items
    await user.click(getTrigger(container))
    await user.type(await screen.findByRole("textbox"), "gpt")

    // Validate — the Embedding heading and its option are removed
    await waitFor(() => {
      expect(screen.getByText("LLM")).toBeInTheDocument()
      expect(screen.queryByText("Embedding")).not.toBeInTheDocument()
      expect(screen.getAllByRole("option")).toHaveLength(2)
    })
  })

  // ── 6.31 Grouped items as tabs ────────────────────────────────────────────

  it("[tag:select-dropdown][tag:groups][tag:tabs] should render side-by-side tabs and show only the active tab's items", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown groups={GROUPS} options={{ isMultiSelect: true, groupsAsTabs: true }} />,
    )

    // Execute
    await user.click(getTrigger(container))

    // Validate — a tab per group, first active by default
    const tabs = await screen.findAllByRole("tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveTextContent("LLM")
    expect(tabs[1]).toHaveTextContent("Embedding")
    expect(tabs[0]).toHaveAttribute("aria-selected", "true")

    // Only the active (LLM) tab's items are shown
    expect(screen.getByRole("option", { name: "GPT-4o" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "Text Embedding 3" })).not.toBeInTheDocument()

    // Switching tabs swaps the visible items
    await user.click(tabs[1])
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Text Embedding 3" })).toBeInTheDocument()
      expect(screen.queryByRole("option", { name: "GPT-4o" })).not.toBeInTheDocument()
    })
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true")
  })

  it("[tag:select-dropdown][tag:groups][tag:tabs][tag:search] should filter within the active tab and show per-tab match counts", async () => {
    // Setup
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectDropdown groups={GROUPS} options={{ isSearchable: true, groupsAsTabs: true }} />,
    )

    // Execute — "embed" matches nothing in the active LLM tab, one Embedding item
    await user.click(getTrigger(container))
    await user.type(await screen.findByRole("textbox"), "embed")

    // Validate — tab counts reflect the filtered matches
    const tabs = screen.getAllByRole("tab")
    expect(tabs[0]).toHaveTextContent(/LLM\s*0/)
    expect(tabs[1]).toHaveTextContent(/Embedding\s*1/)

    // Active LLM tab has no matches → no options are listed
    expect(screen.queryByRole("option")).not.toBeInTheDocument()

    // Switching to the Embedding tab reveals the matching item
    await user.click(tabs[1])
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Text Embedding 3" })).toBeInTheDocument()
    })
  })
})
