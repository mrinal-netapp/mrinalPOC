import { Menu } from "@base-ui/react/menu"
import { IconChevronRight, IconCheck } from "@tabler/icons-react"
import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { useFloatingLayerZIndex } from "@/ui-lib/lib/floating-layer-context"
import "./dropdown-menu.scss"

// -- Root

type DropdownMenuProps = Menu.Root.Props

function DropdownMenu({ ...props }: DropdownMenuProps): ReactElement {
  return <Menu.Root {...props} />
}

// -- Trigger

type DropdownMenuTriggerProps = Menu.Trigger.Props

function DropdownMenuTrigger({
  className,
  ...props
}: DropdownMenuTriggerProps): ReactElement {
  return (
    <Menu.Trigger
      data-slot="dropdown-menu-trigger"
      className={cn("dropdown-menu__trigger", className)}
      {...props}
    />
  )
}

// -- Content (Positioner + Popup)

interface DropdownMenuContentProps extends Menu.Popup.Props {
  side?: Menu.Positioner.Props["side"]
  sideOffset?: Menu.Positioner.Props["sideOffset"]
  align?: Menu.Positioner.Props["align"]
  alignOffset?: Menu.Positioner.Props["alignOffset"]
}

function DropdownMenuContent({
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  className,
  children,
  ...props
}: DropdownMenuContentProps): ReactElement {
  // Stack above the surrounding floating layer (e.g. a modal dialog raises this
  // to its popup z-index via FloatingLayerContext). Defaults to the standalone
  // floating-layer z-index when not nested in a dialog.
  const zIndex = useFloatingLayerZIndex()
  return (
    <Menu.Portal>
      <Menu.Positioner
        className="dropdown-menu__positioner"
        style={{ zIndex }}
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
      >
        <Menu.Popup
          data-slot="dropdown-menu-content"
          className={cn("dropdown-menu__content", className)}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  )
}

// -- Item

interface DropdownMenuItemProps extends Menu.Item.Props {
  variant?: "default" | "destructive"
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: DropdownMenuItemProps): ReactElement {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn("dropdown-menu__item", className)}
      {...props}
    />
  )
}

// -- Label

type DropdownMenuLabelProps = Menu.GroupLabel.Props

function DropdownMenuLabel({
  className,
  children,
  ...props
}: DropdownMenuLabelProps): ReactElement {
  return (
    <Menu.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn("dropdown-menu__label", className)}
      {...props}
    >
      <Typography Component="span" fontSize="fs13" boldness="regular">
        {children}
      </Typography>
    </Menu.GroupLabel>
  )
}

// -- Separator

type DropdownMenuSeparatorProps = Menu.Separator.Props

function DropdownMenuSeparator({
  className,
  ...props
}: DropdownMenuSeparatorProps): ReactElement {
  return (
    <Menu.Separator
      data-slot="dropdown-menu-separator"
      className={cn("dropdown-menu__separator", className)}
      {...props}
    />
  )
}

// -- Group

type DropdownMenuGroupProps = Menu.Group.Props

function DropdownMenuGroup({
  className,
  ...props
}: DropdownMenuGroupProps): ReactElement {
  return (
    <Menu.Group
      data-slot="dropdown-menu-group"
      className={cn("dropdown-menu__group", className)}
      {...props}
    />
  )
}

// -- CheckboxItem

type DropdownMenuCheckboxItemProps = Menu.CheckboxItem.Props

function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: DropdownMenuCheckboxItemProps): ReactElement {
  return (
    <Menu.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn("dropdown-menu__checkbox-item", className)}
      {...props}
    >
      <span className="dropdown-menu__indicator">
        <Menu.CheckboxItemIndicator>
          <IconCheck size={14} />
        </Menu.CheckboxItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  )
}

// -- RadioGroup

type DropdownMenuRadioGroupProps = Menu.RadioGroup.Props

function DropdownMenuRadioGroup({
  className,
  ...props
}: DropdownMenuRadioGroupProps): ReactElement {
  return (
    <Menu.RadioGroup
      data-slot="dropdown-menu-radio-group"
      className={cn("dropdown-menu__radio-group", className)}
      {...props}
    />
  )
}

// -- RadioItem

type DropdownMenuRadioItemProps = Menu.RadioItem.Props

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: DropdownMenuRadioItemProps): ReactElement {
  return (
    <Menu.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn("dropdown-menu__radio-item", className)}
      {...props}
    >
      <span className="dropdown-menu__indicator">
        <Menu.RadioItemIndicator>
          <IconCheck size={14} />
        </Menu.RadioItemIndicator>
      </span>
      {children}
    </Menu.RadioItem>
  )
}

// -- Sub (submenu root)

type DropdownMenuSubProps = Menu.SubmenuRoot.Props

function DropdownMenuSub({ ...props }: DropdownMenuSubProps): ReactElement {
  return <Menu.SubmenuRoot {...props} />
}

// -- SubTrigger

type DropdownMenuSubTriggerProps = Menu.SubmenuTrigger.Props

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: DropdownMenuSubTriggerProps): ReactElement {
  return (
    <Menu.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn("dropdown-menu__sub-trigger", className)}
      {...props}
    >
      {children}
      <IconChevronRight size={14} className="dropdown-menu__chevron" />
    </Menu.SubmenuTrigger>
  )
}

// -- SubContent

type DropdownMenuSubContentProps = DropdownMenuContentProps

function DropdownMenuSubContent({
  side = "inline-end",
  sideOffset = 0,
  align = "start",
  alignOffset = -3,
  className,
  ...props
}: DropdownMenuSubContentProps): ReactElement {
  return (
    <DropdownMenuContent
      side={side}
      sideOffset={sideOffset}
      align={align}
      alignOffset={alignOffset}
      className={cn("dropdown-menu__sub-content", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}

export type {
  DropdownMenuProps,
  DropdownMenuTriggerProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuLabelProps,
  DropdownMenuSeparatorProps,
  DropdownMenuGroupProps,
  DropdownMenuCheckboxItemProps,
  DropdownMenuRadioGroupProps,
  DropdownMenuRadioItemProps,
  DropdownMenuSubProps,
  DropdownMenuSubTriggerProps,
  DropdownMenuSubContentProps,
}
