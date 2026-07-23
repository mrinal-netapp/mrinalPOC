import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "./sidebar"

describe("Sidebar primitives", () => {
  describe("Sidebar", () => {
    // -- 1.1 Default expanded state
    it("[tag:sidebar][tag:expanded] should render as expanded with sidebar class and children when no props are given", () => {
      renderWithProviders(
        <Sidebar>
          <div data-testid="child">content</div>
        </Sidebar>,
      )

      const aside = screen.getByRole("complementary")
      expect(aside).toHaveAttribute("data-slot", "sidebar")
      expect(aside).toHaveAttribute("data-state", "expanded")
      expect(aside).toHaveClass("sidebar")
      expect(screen.getByTestId("child")).toBeInTheDocument()
    })

    // -- 1.2 Collapsed state
    it("[tag:sidebar][tag:collapsed] should render as collapsed when open is false", () => {
      renderWithProviders(<Sidebar open={false}>content</Sidebar>)

      expect(screen.getByRole("complementary")).toHaveAttribute("data-state", "collapsed")
    })

    // -- 1.3 Explicit expanded state
    it("[tag:sidebar][tag:expanded] should render as expanded when open is explicitly true", () => {
      renderWithProviders(<Sidebar open={true}>content</Sidebar>)

      expect(screen.getByRole("complementary")).toHaveAttribute("data-state", "expanded")
    })

    // -- 1.4 className merging
    it("[tag:sidebar] should merge custom className with sidebar class", () => {
      renderWithProviders(<Sidebar className="custom">content</Sidebar>)

      const aside = screen.getByRole("complementary")
      expect(aside).toHaveClass("sidebar", "custom")
    })

    // -- 1.5 Prop forwarding
    it("[tag:sidebar] should forward aria-label and id to the aside element", () => {
      renderWithProviders(
        <Sidebar aria-label="Navigation" id="main-sidebar">
          content
        </Sidebar>,
      )

      const aside = screen.getByRole("complementary", { name: "Navigation" })
      expect(aside).toHaveAttribute("id", "main-sidebar")
    })
  })

  describe("SidebarHeader", () => {
    // -- 1.6 Renders children in Typography
    it("[tag:sidebar-header][tag:typography] should render children text with data-slot attribute", () => {
      renderWithProviders(<SidebarHeader>Title</SidebarHeader>)

      expect(screen.getByText("Title")).toBeInTheDocument()
      const header = screen.getByText("Title").closest("[data-slot='sidebar-header']")
      expect(header).toBeInTheDocument()
    })

    // -- 1.7 className merging
    it("[tag:sidebar-header][tag:typography] should merge custom className with sidebar-header class", () => {
      const { container } = renderWithProviders(
        <SidebarHeader className="custom">Title</SidebarHeader>,
      )

      const header = container.querySelector("[data-slot='sidebar-header']")
      expect(header).toHaveClass("sidebar-header", "custom")
    })
  })

  describe("SidebarContent", () => {
    // -- 1.8 Renders with data-slot
    it("[tag:sidebar-content] should render with data-slot and sidebar-content class", () => {
      renderWithProviders(<SidebarContent data-testid="content" />)

      const content = screen.getByTestId("content")
      expect(content).toHaveAttribute("data-slot", "sidebar-content")
      expect(content).toHaveClass("sidebar-content")
    })

    // -- 1.9 className merging and prop forwarding
    it("[tag:sidebar-content] should merge custom className and forward id prop", () => {
      renderWithProviders(
        <SidebarContent className="custom" id="scroll-area" data-testid="content" />,
      )

      const content = screen.getByTestId("content")
      expect(content).toHaveClass("sidebar-content", "custom")
      expect(content).toHaveAttribute("id", "scroll-area")
    })
  })

  describe("SidebarGroup", () => {
    // -- 1.10 Renders with data-slot
    it("[tag:sidebar-group] should render with data-slot and sidebar-group class", () => {
      renderWithProviders(<SidebarGroup data-testid="group" />)

      const group = screen.getByTestId("group")
      expect(group).toHaveAttribute("data-slot", "sidebar-group")
      expect(group).toHaveClass("sidebar-group")
    })

    // -- 1.11 className merging
    it("[tag:sidebar-group] should merge custom className with sidebar-group class", () => {
      renderWithProviders(<SidebarGroup className="custom" data-testid="group" />)

      expect(screen.getByTestId("group")).toHaveClass("sidebar-group", "custom")
    })
  })

  describe("SidebarGroupLabel", () => {
    // -- 1.12 Renders children in Typography
    it("[tag:sidebar-group-label][tag:typography] should render children text with data-slot attribute", () => {
      renderWithProviders(<SidebarGroupLabel>Nav</SidebarGroupLabel>)

      expect(screen.getByText("Nav")).toBeInTheDocument()
      const label = screen.getByText("Nav").closest("[data-slot='sidebar-group-label']")
      expect(label).toBeInTheDocument()
    })

    // -- 1.13 className merging
    it("[tag:sidebar-group-label][tag:typography] should merge custom className with sidebar-group-label class", () => {
      const { container } = renderWithProviders(
        <SidebarGroupLabel className="custom">Nav</SidebarGroupLabel>,
      )

      const label = container.querySelector("[data-slot='sidebar-group-label']")
      expect(label).toHaveClass("sidebar-group-label", "custom")
    })
  })

  describe("SidebarMenu", () => {
    // -- 1.14 Renders as <ul> with data-slot and children
    it("[tag:sidebar-menu] should render as ul element with data-slot, sidebar-menu class, and children", () => {
      renderWithProviders(
        <SidebarMenu>
          <li>item</li>
        </SidebarMenu>,
      )

      const menu = screen.getByRole("list")
      expect(menu).toHaveAttribute("data-slot", "sidebar-menu")
      expect(menu).toHaveClass("sidebar-menu")
      expect(screen.getByText("item")).toBeInTheDocument()
    })

    // -- 1.15 className merging and children rendering
    it("[tag:sidebar-menu] should merge custom className and render children", () => {
      renderWithProviders(
        <SidebarMenu className="custom">
          <li>item</li>
        </SidebarMenu>,
      )

      const menu = screen.getByRole("list")
      expect(menu).toHaveClass("sidebar-menu", "custom")
      expect(screen.getByText("item")).toBeInTheDocument()
    })
  })

  describe("SidebarMenuItem", () => {
    // -- 1.16 Renders as <li> with data-slot
    it("[tag:sidebar-menu-item] should render as li element with data-slot and sidebar-menu-item class", () => {
      renderWithProviders(
        <ul>
          <SidebarMenuItem>item</SidebarMenuItem>
        </ul>,
      )

      const item = screen.getByRole("listitem")
      expect(item).toHaveAttribute("data-slot", "sidebar-menu-item")
      expect(item).toHaveClass("sidebar-menu-item")
    })

    // -- 1.17 className merging
    it("[tag:sidebar-menu-item] should merge custom className with sidebar-menu-item class", () => {
      renderWithProviders(
        <ul>
          <SidebarMenuItem className="custom">item</SidebarMenuItem>
        </ul>,
      )

      expect(screen.getByRole("listitem")).toHaveClass("sidebar-menu-item", "custom")
    })
  })

  describe("SidebarMenuButton", () => {
    // -- 1.18 Default render (label, class, inactive)
    it("[tag:sidebar-menu-button][tag:button][tag:spinner][tag:inactive] should render label, sidebar-menu-button class, and no data-active by default", () => {
      const { container } = renderWithProviders(
        <SidebarMenuButton label="Home" />,
      )

      expect(screen.getByText("Home")).toBeInTheDocument()
      expect(container.querySelector(".sidebar-menu-button")).toBeInTheDocument()
      expect(container.querySelector(".sidebar-menu-button")).not.toHaveAttribute("data-active")
    })

    // -- 1.19 Active state
    it("[tag:sidebar-menu-button][tag:button][tag:spinner][tag:active] should set data-active attribute when isActive is true", () => {
      const { container } = renderWithProviders(
        <SidebarMenuButton label="Home" isActive={true} />,
      )

      expect(container.querySelector(".sidebar-menu-button")).toHaveAttribute("data-active")
    })

    // -- 1.21 Fires onClick
    it("[tag:sidebar-menu-button][tag:button][tag:spinner] should fire onClick callback when clicked", async () => {
      // Setup
      const user = userEvent.setup()
      const handleClick = vi.fn()

      // Execute
      renderWithProviders(
        <SidebarMenuButton label="Home" onButtonClick={handleClick} />,
      )
      await user.click(screen.getByRole("button"))

      // Validate
      expect(handleClick).toHaveBeenCalledOnce()
    })

    // -- 1.22 Renders icon
    it("[tag:sidebar-menu-button][tag:button][tag:spinner] should render icon when provided", () => {
      renderWithProviders(
        <SidebarMenuButton label="Home" icon={<svg data-testid="icon-svg" />} />,
      )

      expect(screen.getByTestId("icon-svg")).toBeInTheDocument()
    })

    // -- 1.23 className merging
    it("[tag:sidebar-menu-button][tag:button][tag:spinner] should merge custom className with sidebar-menu-button class", () => {
      const { container } = renderWithProviders(
        <SidebarMenuButton label="Home" className="custom" />,
      )

      expect(container.querySelector(".sidebar-menu-button")).toHaveClass(
        "sidebar-menu-button",
        "custom",
      )
    })
  })

  describe("SidebarRail", () => {
    // -- 1.24 Default (non-interactive) renders as div with data-slot
    it("[tag:sidebar-rail] should render as a non-interactive div with data-slot by default", () => {
      // Execute
      const { container } = renderWithProviders(<SidebarRail />)

      // Validate
      const rail = container.querySelector("[data-slot='sidebar-rail']")
      expect(rail).not.toBeNull()
      expect(rail?.tagName).toBe("DIV")
      expect(rail).toHaveClass("sidebar-rail")
      expect(screen.queryByRole("button", { name: "Toggle Sidebar" })).toBeNull()
    })

    // -- 1.25 Interactive mode renders as focusable button
    it("[tag:sidebar-rail][tag:button][tag:spinner] should render as a focusable button when interactive", async () => {
      // Setup
      const user = userEvent.setup()
      const handleToggle = vi.fn()

      // Execute
      renderWithProviders(<SidebarRail isInteractive onRailClick={handleToggle} />)
      const rail = screen.getByRole("button", { name: "Toggle Sidebar" })
      await user.click(rail)

      // Validate
      expect(rail).toHaveClass("sidebar-rail")
      expect(handleToggle).toHaveBeenCalledOnce()
    })

    // -- 1.26 className merging
    it("[tag:sidebar-rail] should merge custom className", () => {
      // Execute
      const { container } = renderWithProviders(<SidebarRail className="custom" />)

      // Validate
      const rail = container.querySelector("[data-slot='sidebar-rail']")
      expect(rail).toHaveClass("sidebar-rail", "custom")
    })
  })
})
