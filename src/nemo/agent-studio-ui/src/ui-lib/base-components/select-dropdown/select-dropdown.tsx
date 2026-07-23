import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { IconChevronDown, IconCircleX, IconAlertTriangle, IconInfoCircle, IconX } from "@tabler/icons-react"
import React, { type ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "../button/button"
import { FlashingDotsLoader } from "../flashing-dots-loader/flashing-dots-loader"
import { ChipList } from "../chip-list/chip-list"
import { selectDropdownWrapperVariants } from "./select-dropdown.variants"
import { SelectDropdownTrigger } from "./select-dropdown.trigger"
import { SelectDropdownContent, SelectDropdownList, SelectDropdownEmpty, SelectDropdownGroup, SelectDropdownLabel } from "./select-dropdown.content"
import { SelectDropdownItem, SelectDropdownItemCell } from "./select-dropdown.cell"
import { SelectDropdownSearchBar, SelectDropdownSelectAll } from "./select-dropdown.controls"
import type { SelectDropdownItemData, SelectDropdownValue, SelectDropdownProps } from "./select-dropdown.types"
import "./select-dropdown.scss"

const SelectDropdownRoot = ComboboxPrimitive.Root

function SelectDropdown({
  options,
  placeholder = "Select...",
  variant = "field",
  size = "medium",
  className,
  items = [],
  groups,
  label,
  tooltip,
  error,
  warning,
  emptyMessage = "No options available",
  renderCell,
  value,
  onValueChange,
  onOpenChange: userOnOpenChange,
  onAddNew,
  defaultValue,
  disabled,
  isLoading,
  id,
  ...props
}: SelectDropdownProps): ReactElement {
  const { isMultiSelect, isSelectAllEnabled, isChipDisplay, groupsAsTabs, isOptional, isReadOnly, isClearable, cellHasCheckbox,
    isCellMultiline, isSearchable, isSearchbarDisabled, isSearchbarLoading, canAddNew, searchbarPlaceholder } = options ?? {}

  const [uncontrolledValue, setUncontrolledValue] = React.useState<string | number | (string | number)[] | null>(defaultValue ?? null)
  const [clearCount, setClearCount] = React.useState(0)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [activeGroupKey, setActiveGroupKey] = React.useState<string | null>(null)
  const isControlled = value !== undefined
  const currentValue = isControlled ? value : uncontrolledValue

  // Tab strip only makes sense with 2+ groups; a single group renders flat.
  const showGroupTabs = !!groupsAsTabs && !!groups && groups.length > 1
  // Active tab falls back to the first group so a stale/absent key never blanks the list.
  const activeGroupKeyResolved = React.useMemo(() => {
    if (!groups || groups.length === 0) return null
    if (activeGroupKey && groups.some((g) => g.key === activeGroupKey)) return activeGroupKey
    return groups[0].key
  }, [groups, activeGroupKey])

  /*
   * REFACTOR: These suppress real type mismatches rather than resolving them,
   * match base ui behavior to BluXP after 1st release
   *  AIAS-461/Refactor for the comboBox
   */
  function handleOpenChange(open: boolean, event: Event | undefined): void {
    if (isReadOnly) return
    if (!open) {
      setSearchQuery("")
      setActiveGroupKey(null)
    }
    userOnOpenChange?.(open as never, event as never)
  }

  /*
   * When `groups` is provided it is the source of truth for both the rendered
   * layout and value resolution; `flatItems` collapses the groups so chips,
   * the trigger label, select-all and search all keep working unchanged.
   */
  const flatItems = React.useMemo<SelectDropdownItemData[]>(
    () => (groups ? groups.flatMap((g) => g.items) : items),
    [groups, items],
  )

  const trimmedQuery = searchQuery.trim().toLowerCase()
  const matchesQuery = React.useCallback(
    (item: SelectDropdownItemData) =>
      !isSearchable || trimmedQuery === "" || item.label.toLowerCase().includes(trimmedQuery),
    [isSearchable, trimmedQuery],
  )

  const filteredItems = React.useMemo(
    () => flatItems.filter(matchesQuery),
    [flatItems, matchesQuery],
  )

  // Items shown when rendering `groups` as tabs: only the active tab, filtered.
  const activeGroupFilteredItems = React.useMemo(() => {
    if (!groups) return []
    const active = groups.find((g) => g.key === activeGroupKeyResolved) ?? groups[0]
    return active ? active.items.filter(matchesQuery) : []
  }, [groups, activeGroupKeyResolved, matchesQuery])

  const handleValueChange = React.useCallback(
    (newVal: SelectDropdownValue, eventDetails: unknown) => {
      if (!isControlled) {
        setUncontrolledValue(newVal)
      }
      onValueChange?.(newVal, eventDetails)
    },
    [isControlled, onValueChange],
  )

  const hasValue = isMultiSelect
    ? Array.isArray(currentValue) && (currentValue as unknown[]).length > 0
    : currentValue !== null && currentValue !== undefined && currentValue !== ""

  const showClear = hasValue && !!isClearable && !disabled && !isReadOnly && !isLoading

  function resolveDisplayText(values: unknown): { text: string | null; isPlaceholder: boolean } {
    if (isMultiSelect) {
      if (!Array.isArray(values) || values.length === 0) {
        return { text: placeholder, isPlaceholder: true }
      }
      return { text: `${values.length} selected`, isPlaceholder: false }
    }
    if (values === null || values === undefined || values === "") {
      return { text: placeholder, isPlaceholder: true }
    }
    return { text: flatItems.find((item) => Object.is(item.value, values))?.label ?? String(values), isPlaceholder: false }
  }

  function renderValue(values: unknown): React.ReactNode {
    if (isChipDisplay && isMultiSelect && variant === "field") {
      const selectedValues = Array.isArray(values) ? (values as (string | number)[]) : []
      if (selectedValues.length === 0) {
        return <span className="select-dropdown-placeholder">{placeholder}</span>
      }
      return (
        <ChipList
          values={selectedValues}
          getLabel={(v) => flatItems.find((item) => Object.is(item.value, v))?.label ?? String(v)}
          onRemove={(v) => {
            const newValues = selectedValues.filter((sv) => !Object.is(sv, v))
            handleValueChange(newValues, undefined)
          }}
          isDisabled={!!disabled || !!isReadOnly}
        />
      )
    }

    const { text, isPlaceholder } = resolveDisplayText(values)
    if (isPlaceholder) {
      return <span className="select-dropdown-placeholder">{text}</span>
    }
    return text
  }

  function renderUnderlineValue(values: unknown): React.ReactNode {
    const { text, isPlaceholder } = resolveDisplayText(values)
    if (!label) {
      return isPlaceholder ? <span className="select-dropdown-placeholder">{text}</span> : text
    }
    if (isPlaceholder) {
      return (
        <>
          <span className="select-dropdown-underline-label-prefix">{label}:</span>
          {" "}
          <span className="select-dropdown-placeholder">{text}</span>
        </>
      )
    }
    return `${label}: ${text}`
  }

  function handleClear(e: React.MouseEvent): void {
    e.preventDefault()
    handleValueChange(isMultiSelect ? [] : null, undefined)
    if (!isControlled) {
      setClearCount(c => c + 1)
    }
  }

  function renderItem(item: SelectDropdownItemData): ReactElement {
    return (
      <SelectDropdownItem key={item.key} value={item.value} disabled={item.isDisabled} cellHasCheckbox={cellHasCheckbox} isCellMultiline={isCellMultiline}>
        {renderCell ? renderCell(item) : (
          <SelectDropdownItemCell
            label={item.label}
            sublabel={item.sublabel}
            isDisabled={item.isDisabled}
            cellHasCheckbox={cellHasCheckbox ?? false}
            isCellMultiline={isCellMultiline ?? false}
          />
        )}
      </SelectDropdownItem>
    )
  }

  const rootContent = (
    <SelectDropdownRoot
      key={isControlled ? undefined : clearCount}
      value={value}
      onValueChange={handleValueChange as never}
      onOpenChange={handleOpenChange as never}
      multiple={isMultiSelect}
      disabled={disabled || !!isLoading}
      defaultValue={!isControlled && clearCount === 0 ? defaultValue : undefined}
      {...props}
    >
      <div className={cn("select-dropdown-trigger-container", showClear && "select-dropdown-trigger-container--with-clear")}>
        <SelectDropdownTrigger
          id={id}
          isDisabled={disabled || !!isLoading}
          isReadOnly={!!isReadOnly}
          className={cn(showClear && "select-dropdown-trigger--with-clear")}
          placeholder={placeholder}
          variant={variant}
          renderValue={variant === "underline" ? renderUnderlineValue : renderValue}
          hideChevron
        />
        {/* Icons overlay: [X?] [▼] — pointer-events:none lets chevron clicks fall through to trigger */}
        <div className="select-dropdown-trigger-icons">
          {showClear && (
            <Button
              variant="icon"
              size="medium"
              className="select-dropdown-clear"
              onClick={handleClear}
              aria-label="Clear selection"
              icon={<IconX className="select-dropdown-clear-icon" />}
            />
          )}
          {isLoading ? (
            <FlashingDotsLoader isGrey={false} />
          ) : (
            <IconChevronDown className="select-dropdown-trigger-icon select-dropdown-chevron" aria-hidden="true" />
          )}
        </div>
      </div>
      <SelectDropdownContent options={options}>
        {showGroupTabs && groups && (
          <div className="select-dropdown-tabs" role="tablist">
            {groups.map((group) => {
              const isActive = group.key === activeGroupKeyResolved
              const matchCount = group.items.filter(matchesQuery).length
              return (
                <button
                  key={group.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={cn("select-dropdown-tab", isActive && "select-dropdown-tab--active")}
                  // Keep focus in the popup so switching tabs doesn't dismiss it.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setActiveGroupKey(group.key)}
                >
                  <span className="select-dropdown-tab-label">{group.label}</span>
                  <span className="select-dropdown-tab-count">{matchCount}</span>
                </button>
              )
            })}
          </div>
        )}
        {isSearchable && (
          <SelectDropdownSearchBar
            isDisabled={!!disabled || !!isSearchbarDisabled}
            canAddNew={!!canAddNew}
            items={flatItems}
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            onAddNew={onAddNew}
            placeholder={searchbarPlaceholder}
            isSearchbarLoading={!!isSearchbarLoading}
          />
        )}
        <SelectDropdownList className={(!isSearchable && (filteredItems.length > 0 || (isMultiSelect && isSelectAllEnabled))) ? "select-dropdown-list--with-items" : undefined}>
          {isMultiSelect && isSelectAllEnabled && (
            <SelectDropdownSelectAll
              items={flatItems}
              currentValue={currentValue}
              onValueChange={handleValueChange}
            />
          )}
          {(showGroupTabs ? activeGroupFilteredItems.length === 0 : filteredItems.length === 0) && emptyMessage && (
            <SelectDropdownEmpty>{emptyMessage}</SelectDropdownEmpty>
          )}
          {showGroupTabs
            ? activeGroupFilteredItems.map(renderItem)
            : groups
              ? groups.map((group) => {
                  const groupItems = group.items.filter(matchesQuery)
                  if (groupItems.length === 0) return null
                  return (
                    <SelectDropdownGroup key={group.key}>
                      <SelectDropdownLabel>{group.label}</SelectDropdownLabel>
                      {groupItems.map(renderItem)}
                    </SelectDropdownGroup>
                  )
                })
              : filteredItems.map(renderItem)}
        </SelectDropdownList>
      </SelectDropdownContent>
    </SelectDropdownRoot>
  )

  const footer = (
    <>
      {error && (
        <div className="select-dropdown-footer select-dropdown-footer--error">
          <IconCircleX className="select-dropdown-footer-icon" />
          <span className="select-dropdown-footer-label">Error:</span>
          <span className="select-dropdown-footer-message">{error}</span>
        </div>
      )}
      {warning && !error && (
        <div className="select-dropdown-footer select-dropdown-footer--warning">
          <IconAlertTriangle className="select-dropdown-footer-icon" />
          <span className="select-dropdown-footer-label">Warning:</span>
          <span className="select-dropdown-footer-message">{warning}</span>
        </div>
      )}
    </>
  )

  if (variant === "underline") {
    return (
      <div
        className={cn(
          selectDropdownWrapperVariants({ size }),
          "select-dropdown-wrapper--underline",
          disabled && "select-dropdown-wrapper--disabled",
          isReadOnly && "select-dropdown-wrapper--readonly",
          error && "select-dropdown-wrapper--error",
          warning && !error && "select-dropdown-wrapper--warning",
          className,
        )}
      >
        <div className="select-dropdown-underline-row">
          {rootContent}
          {tooltip && (
            <span className="select-dropdown-header-tooltip" data-tooltip={tooltip} aria-label={tooltip}>
              <IconInfoCircle className="select-dropdown-header-tooltip-icon" />
            </span>
          )}
        </div>
        {footer}
      </div>
    )
  }

  return (
    <div
      className={cn(
        selectDropdownWrapperVariants({ size }),
        "select-dropdown-wrapper--field",
        disabled && "select-dropdown-wrapper--disabled",
        isReadOnly && "select-dropdown-wrapper--readonly",
        error && "select-dropdown-wrapper--error",
        warning && !error && "select-dropdown-wrapper--warning",
        className,
      )}
    >
      {(label || isOptional || tooltip) && (
        <div className="select-dropdown-header">
          {label && <span className="select-dropdown-header-label">{label}</span>}
          <div className="select-dropdown-header-right">
            {isOptional && <span className="select-dropdown-header-optional">Optional</span>}
            {tooltip && (
              <span className="select-dropdown-header-tooltip" data-tooltip={tooltip} aria-label={tooltip}>
                <IconInfoCircle className="select-dropdown-header-tooltip-icon" />
              </span>
            )}
          </div>
        </div>
      )}
      {rootContent}
      {footer}
    </div>
  )
}

// -- Barrel exports ----------------------------------------------------------

export type { SelectDropdownOption, SelectDropdownItemData, SelectDropdownItemGroup, SelectDropdownValue, SelectDropdownProps } from "./select-dropdown.types"

export { SelectDropdownRoot, SelectDropdown }
export { SelectDropdownTrigger } from "./select-dropdown.trigger"
export { SelectDropdownContent, SelectDropdownList, SelectDropdownEmpty, SelectDropdownSeparator, SelectDropdownGroup, SelectDropdownLabel, SelectDropdownCollection } from "./select-dropdown.content"
export { SelectDropdownItem, SelectDropdownItemCell } from "./select-dropdown.cell"
export { SelectDropdownSearchBar, SelectDropdownSelectAll } from "./select-dropdown.controls"
