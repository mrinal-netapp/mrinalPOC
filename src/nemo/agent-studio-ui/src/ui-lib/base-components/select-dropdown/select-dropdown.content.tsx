import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { useFloatingLayerZIndex } from "@/ui-lib/lib/floating-layer-context"
import type { SelectDropdownOption } from "./select-dropdown.types"

function SelectDropdownContent({
  className,
  options,
  ...props
}: ComboboxPrimitive.Popup.Props & { options?: SelectDropdownOption }): ReactElement {
  const { side = "bottom", sideOffset = 0, align = "start", alignOffset = 0, collisionAvoidance } = options ?? {}
  const zIndex = useFloatingLayerZIndex()

  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionAvoidance={collisionAvoidance}
        className="select-dropdown-positioner"
        style={{ zIndex }}
      >
        <ComboboxPrimitive.Popup
          data-slot="select-dropdown-content"
          className={cn("select-dropdown-content", className)}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function SelectDropdownList({ className, ...props }: ComboboxPrimitive.List.Props): ReactElement {
  return (
    <ComboboxPrimitive.List
      data-slot="select-dropdown-list"
      className={cn("select-dropdown-list", className)}
      {...props}
    />
  )
}

function SelectDropdownEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props): ReactElement {
  return (
    <ComboboxPrimitive.Empty
      data-slot="select-dropdown-empty"
      className={cn("select-dropdown-empty", className)}
      {...props}
    />
  )
}

function SelectDropdownSeparator({ className, ...props }: ComboboxPrimitive.Separator.Props): ReactElement {
  return (
    <ComboboxPrimitive.Separator
      data-slot="select-dropdown-separator"
      className={cn("select-dropdown-separator", className)}
      {...props}
    />
  )
}

function SelectDropdownGroup({ className, ...props }: ComboboxPrimitive.Group.Props): ReactElement {
  return (
    <ComboboxPrimitive.Group
      data-slot="select-dropdown-group"
      className={cn("select-dropdown-group", className)}
      {...props}
    />
  )
}

function SelectDropdownLabel({ className, ...props }: ComboboxPrimitive.GroupLabel.Props): ReactElement {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="select-dropdown-label"
      className={cn("select-dropdown-label", className)}
      {...props}
    />
  )
}

/* v8 ignore next -- @preserve */ //SelectDropdownCollection requires Base UI's internal item-collection context to render without crashing — can't be tested in isolation in jsdom
function SelectDropdownCollection({ ...props }: ComboboxPrimitive.Collection.Props): ReactElement {
  return <ComboboxPrimitive.Collection data-slot="select-dropdown-collection" {...props} />
}

export {
  SelectDropdownContent,
  SelectDropdownList,
  SelectDropdownEmpty,
  SelectDropdownSeparator,
  SelectDropdownGroup,
  SelectDropdownLabel,
  SelectDropdownCollection,
}
