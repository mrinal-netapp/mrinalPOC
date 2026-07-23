import React, { type ReactNode } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Button } from "../button/button"
import { Typography } from "../typography/typography"
import "./sidebar.scss"

// -- Sidebar (root container) --

interface SidebarProps extends React.ComponentProps<"aside"> {
  open?: boolean
}

function Sidebar({ open = true, className, children, ...props }: SidebarProps) {
  const state = open ? "expanded" : "collapsed"

  return (
    <aside
      data-slot="sidebar"
      data-state={state}
      className={cn("sidebar", className)}
      {...props}
    >
      <div className="sidebar-inner">{children}</div>
    </aside>
  )
}

// -- SidebarHeader --

function SidebarHeader({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("sidebar-header", className)}
      {...props}
    >
      <Typography Component="span" fontSize="fs14" boldness="semibold">
        {children}
      </Typography>
    </div>
  )
}

// -- SidebarContent (scrollable area) --

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("sidebar-content", className)}
      {...props}
    />
  )
}

// -- SidebarGroup --

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("sidebar-group", className)}
      {...props}
    />
  )
}

// -- SidebarGroupLabel --

function SidebarGroupLabel({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn("sidebar-group-label", className)}
      {...props}
    >
      <Typography Component="span" fontSize="fs12">
        {children}
      </Typography>
    </div>
  )
}

// -- SidebarMenu --

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("sidebar-menu", className)}
      {...props}
    />
  )
}

// -- SidebarMenuItem --

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("sidebar-menu-item", className)}
      {...props}
    />
  )
}

// -- SidebarMenuButton (uses Button for consistent interactive behavior) --

interface SidebarMenuButtonProps extends React.ComponentProps<"div"> {
  icon?: ReactNode
  label: string
  isActive?: boolean
  onButtonClick?: React.MouseEventHandler<HTMLButtonElement>
}

function SidebarMenuButton({
  icon,
  label,
  isActive = false,
  className,
  onButtonClick,
  ...props
}: SidebarMenuButtonProps) {
  return (
    <div
      data-slot="sidebar-menu-button"
      className={cn("sidebar-menu-button", className)}
      data-active={isActive || undefined}
      {...props}
    >
      <Button
        variant="flat"
        size="large"
        icon={icon}
        label={label}
        className="sidebar-menu-button__btn"
        onClick={onButtonClick}
      />
    </div>
  )
}

// -- SidebarRail (edge resize/toggle handle) --

interface SidebarRailProps extends React.ComponentProps<"div"> {
  isInteractive?: boolean
  onRailClick?: React.MouseEventHandler<HTMLButtonElement>
}

function SidebarRail({
  isInteractive = false,
  onRailClick,
  className,
  ...props
}: SidebarRailProps): React.JSX.Element {
  const railClass = cn("sidebar-rail", className)

  if (isInteractive) {
    return (
      <Button
        variant="flat"
        aria-label="Toggle Sidebar"
        className={railClass}
        onClick={onRailClick}
      />
    )
  }

  return (
    <div
      data-slot="sidebar-rail"
      className={railClass}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
}
