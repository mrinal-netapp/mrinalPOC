import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { IconSquare, IconSquareCheckFilled } from "@tabler/icons-react"
import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"

function SelectDropdownItem({
  className,
  children,
  cellHasCheckbox = false,
  isCellMultiline = false,
  ...props
}: ComboboxPrimitive.Item.Props & {
  cellHasCheckbox?: boolean
  isCellMultiline?: boolean
}): ReactElement {
  return (
    <ComboboxPrimitive.Item
      data-slot="select-dropdown-item"
      className={cn(
        "select-dropdown-item",
        cellHasCheckbox && "select-dropdown-item--checkbox",
        isCellMultiline && "select-dropdown-item--multiline",
        className,
      )}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Item>
  )
}

interface SelectDropdownItemCellProps {
  label: string
  sublabel?: string
  isDisabled?: boolean
  cellHasCheckbox: boolean
  isCellMultiline: boolean
}

function SelectDropdownItemCell({
  label,
  sublabel,
  isDisabled = false,
  cellHasCheckbox,
  isCellMultiline,
}: SelectDropdownItemCellProps): ReactElement {
  return (
    <span
      className={cn(
        "select-dropdown-item-cell",
        isCellMultiline && "select-dropdown-item-cell--multiline",
        isDisabled && "select-dropdown-item-cell--disabled",
      )}
    >
      {cellHasCheckbox && (
        <span className="select-dropdown-item-cell__checkbox" aria-hidden="true">
          <IconSquare className="select-dropdown-item-cell__checkbox-unchecked" />
          <IconSquareCheckFilled className="select-dropdown-item-cell__checkbox-checked" />
        </span>
      )}
      <span className="select-dropdown-item-cell__text">
        <span className="select-dropdown-item-cell__label">{label}</span>
        {isCellMultiline && sublabel && (
          <span className="select-dropdown-item-cell__sublabel">{sublabel}</span>
        )}
      </span>
    </span>
  )
}

export { SelectDropdownItem, SelectDropdownItemCell }
