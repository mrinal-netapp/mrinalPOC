import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import type { VariantProps } from "class-variance-authority"
import type { ComponentProps, ReactNode } from "react"

import type { selectDropdownVariants, selectDropdownWrapperVariants } from "./select-dropdown.variants"

/**
 * Mirrors CollisionAvoidance from @base-ui/react (SideFlipMode | SideShiftMode).
 * Defined locally because the library doesn't expose it via its package exports map.
 */
type SideFlipMode = { side?: "flip" | "none"; align?: "flip" | "shift" | "none"; fallbackAxisSide?: "start" | "end" | "none" }
type SideShiftMode = { side?: "shift" | "none"; align?: "shift" | "none"; fallbackAxisSide?: "start" | "end" | "none" }
type CollisionAvoidance = SideFlipMode | SideShiftMode

type ComboboxRootProps = ComponentProps<typeof ComboboxPrimitive.Root>

interface SelectDropdownOption {
  isMultiSelect?: boolean
  isSelectAllEnabled?: boolean
  isChipDisplay?: boolean // requires: isMultiSelect: true, variant="field"
  /** Render `groups` as a side-by-side tab strip instead of stacked sections. Requires `groups`. */
  groupsAsTabs?: boolean
  isOptional?: boolean
  isReadOnly?: boolean
  isClearable?: boolean
  isSearchbarLoading?: boolean
  isSearchable?: boolean
  isSearchbarDisabled?: boolean
  canAddNew?: boolean
  searchbarPlaceholder?: string
  cellHasCheckbox?: boolean
  isCellMultiline?: boolean
  side?: "top" | "bottom" | "left" | "right" | "inline-end" | "inline-start"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
  collisionAvoidance?: CollisionAvoidance
}

interface SelectDropdownItemData {
  key: string
  value: string | number
  label: string
  sublabel?: string
  isDisabled?: boolean
}

/**
 * A labelled section of items. When `groups` is supplied to `SelectDropdown`
 * the list renders one heading per group (empty groups, e.g. after a search
 * filter, are hidden). `groups` takes precedence over `items` for the rendered
 * list; value/chip/select-all resolution flattens across all groups.
 */
interface SelectDropdownItemGroup {
  key: string
  label: string
  items: SelectDropdownItemData[]
}

type SelectDropdownValue = string | number | (string | number)[] | null

interface SelectDropdownProps
  extends Omit<ComboboxRootProps, "value" | "defaultValue" | "onValueChange" | "onOpenChange" | "multiple" | "id">,
  VariantProps<typeof selectDropdownVariants>,
  VariantProps<typeof selectDropdownWrapperVariants> {
  /** Applied to the trigger element for label association (`<label for=...>`). */
  id?: string
  value?: SelectDropdownValue
  defaultValue?: SelectDropdownValue
  onValueChange?: (value: SelectDropdownValue, eventDetails: unknown) => void
  onOpenChange?: (open: boolean, event: Event | undefined) => void
  options?: SelectDropdownOption
  placeholder?: string
  className?: string
  items?: SelectDropdownItemData[]
  /** Optional grouped layout. When set, renders section headings per group. */
  groups?: SelectDropdownItemGroup[]
  label?: string
  tooltip?: string
  error?: string
  warning?: string
  emptyMessage?: string
  renderCell?: (item: SelectDropdownItemData) => ReactNode
  onAddNew?: (value: string) => void
  isLoading?: boolean
  disabled?: boolean
}

type SelectAllCheckboxState = "none" | "some" | "all"

/** Multi-select labels field: chips, search, add-new; panel stays below the trigger. */
const LABEL_FIELD_SELECT_OPTIONS: Pick<
  SelectDropdownOption,
  "isMultiSelect" | "isChipDisplay" | "isClearable" | "isSearchable" | "canAddNew" | "side" | "collisionAvoidance"
> = {
  isMultiSelect: true,
  isChipDisplay: true,
  isClearable: true,
  isSearchable: true,
  canAddNew: true,
  side: "bottom",
  collisionAvoidance: { side: "shift", align: "shift", fallbackAxisSide: "none" },
}

export type {
  SelectDropdownOption,
  SelectDropdownItemData,
  SelectDropdownItemGroup,
  SelectDropdownValue,
  SelectDropdownProps,
  SelectAllCheckboxState,
}

export { LABEL_FIELD_SELECT_OPTIONS }
