import { IconPlus, IconSearch, IconSquare, IconSquareCheckFilled, IconSquareMinusFilled, IconX } from "@tabler/icons-react"
import React, { type ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "../button/button"
import { FlashingDotsLoader } from "../flashing-dots-loader/flashing-dots-loader"
import { SelectDropdownSeparator } from "./select-dropdown.content"
import type { SelectDropdownItemData, SelectDropdownValue, SelectAllCheckboxState } from "./select-dropdown.types"

interface SelectDropdownSearchBarProps {
  isDisabled: boolean
  canAddNew: boolean
  items: SelectDropdownItemData[]
  searchValue: string
  onSearchChange: (value: string) => void
  onAddNew?: (value: string) => void
  placeholder?: string
  isSearchbarLoading?: boolean
}

function SelectDropdownSearchBar({
  isDisabled,
  canAddNew,
  items,
  searchValue,
  onSearchChange,
  onAddNew,
  placeholder = "Search",
  isSearchbarLoading = false,
}: SelectDropdownSearchBarProps): ReactElement {
  const inputRef = React.useRef<HTMLInputElement>(null)

  const trimmed = searchValue.trim()
  const isUnique = trimmed !== "" &&
    !items.some((item) => item.label.toLowerCase() === trimmed.toLowerCase())
  const canAdd = !isDisabled && isUnique

  function handleClearSearch(): void {
    onSearchChange("")
    inputRef.current?.focus()
  }

  function handleAdd(): void {
    onAddNew?.(trimmed)
    onSearchChange("")
  }

  return (
    <>
      <div className={cn("select-dropdown-searchbar", isDisabled && "select-dropdown-searchbar--disabled")}>
        <IconSearch className="select-dropdown-searchbar__icon" />
        <input
          ref={inputRef}
          type="text"
          className="select-dropdown-searchbar__input"
          placeholder={canAddNew ? `${placeholder} or add...` : `${placeholder}...`}
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          disabled={isDisabled}
          /* prevent Base UI from intercepting keystrokes and navigating the list */
          onKeyDown={(e) => {
            if (e.key !== "Escape") e.stopPropagation()
            if (e.key === "Enter" && canAdd) {
              handleAdd()
              e.preventDefault()
            }
          }}
        />
        {searchValue && (
          <Button
            variant="icon"
            size="medium"
            className="select-dropdown-searchbar__clear"
            onClick={handleClearSearch}
            isDisabled={isDisabled}
            aria-label="Clear search"
            icon={<IconX className="select-dropdown-searchbar__clear-icon" />}
          />
        )}
        {canAddNew && (
          isSearchbarLoading ? (
            <FlashingDotsLoader isGrey={false} />
          ) : (
            <Button
              variant="flat"
              className="select-dropdown-searchbar__add"
              onClick={handleAdd}
              isDisabled={!canAdd}
              aria-label="Add new item"
              icon={<IconPlus className="select-dropdown-searchbar__add-icon" />}
              label="Add"
            />
          )
        )}
      </div>
      <SelectDropdownSeparator />
    </>
  )
}

interface SelectDropdownSelectAllProps {
  items: SelectDropdownItemData[]
  currentValue: unknown
  onValueChange: (value: SelectDropdownValue, eventDetails: unknown) => void
}

function SelectDropdownSelectAll({
  items,
  currentValue,
  onValueChange,
}: SelectDropdownSelectAllProps): ReactElement {
  const values = Array.isArray(currentValue) ? (currentValue as unknown[]) : []
  const selectableItems = items.filter((item) => !item.isDisabled)

  const checkboxState: SelectAllCheckboxState = (() => {
    const selectedCount = selectableItems.filter((item) =>
      values.some((v) => Object.is(v, item.value)),
    ).length
    if (selectedCount === 0) return "none"
    if (selectedCount === selectableItems.length) return "all"
    return "some"
  })()

  function handleClick(): void {
    if (checkboxState === "all") {
      onValueChange([], undefined)
    } else {
      onValueChange(selectableItems.map((item) => item.value), undefined)
    }
  }

  // Replace with <Checkbox> component when available
  return (
    <button
      type="button"
      className={cn(
        "select-dropdown-select-all",
        checkboxState === "some" && "select-dropdown-select-all--some-selected",
        checkboxState === "all" && "select-dropdown-select-all--all-selected",
      )}
      onClick={handleClick}
      aria-label={checkboxState === "all" ? "Deselect all" : "Select all"}
    >
      <span className="select-dropdown-select-all__checkbox" aria-hidden="true">
        <IconSquare className="select-dropdown-select-all__checkbox-unchecked" />
        <IconSquareMinusFilled className="select-dropdown-select-all__checkbox-indeterminate" />
        <IconSquareCheckFilled className="select-dropdown-select-all__checkbox-checked" />
      </span>
      <span className="select-dropdown-select-all__label">Select All</span>
    </button>
  )
}

export { SelectDropdownSearchBar, SelectDropdownSelectAll }
