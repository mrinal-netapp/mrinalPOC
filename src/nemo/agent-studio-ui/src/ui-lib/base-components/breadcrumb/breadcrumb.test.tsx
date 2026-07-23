import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Breadcrumb } from "./breadcrumb"
import type { BreadcrumbItem } from "./breadcrumb"

// -- helpers

function renderBreadcrumb(items: BreadcrumbItem[], className?: string) {
  return renderWithProviders(<Breadcrumb items={items} className={className} />)
}

// ===== Breadcrumb =====

describe("Breadcrumb", () => {
  // 0 — Empty items guard

  // 0.1
  it("[tag:breadcrumb][tag:rendering] should render nothing when items is empty", () => {
    const { container } = renderBreadcrumb([])

    const nav = container.querySelector("nav")
    expect(nav).not.toBeInTheDocument()
  })

  // 1 — Nav wrapper

  // 1.1
  it("[tag:breadcrumb][tag:rendering] should render nav with data-slot, BEM class, and aria-label", () => {
    const { container } = renderBreadcrumb([{ label: "Home", href: "/" }])

    const nav = container.querySelector("nav")
    expect(nav).toBeInTheDocument()
    expect(nav).toHaveAttribute("data-slot", "breadcrumb")
    expect(nav).toHaveAttribute("aria-label", "breadcrumb")
    expect(nav).toHaveClass("breadcrumb")
  })

  // 1.2
  it("[tag:breadcrumb][tag:className] should forward className to the nav root", () => {
    const { container } = renderBreadcrumb(
      [{ label: "Home", href: "/" }],
      "my-custom-crumb",
    )

    const nav = container.querySelector("nav")
    expect(nav).toHaveClass("breadcrumb", "my-custom-crumb")
  })

  // 2 — Single item (page only)

  // 2.1
  it("[tag:breadcrumb][tag:rendering] should render single item as page (no link, no separator)", () => {
    renderBreadcrumb([{ label: "Dashboard", href: "/dashboard" }])

    const page = screen.getByText("Dashboard")
    expect(page).toBeInTheDocument()

    const pageSlot = page.closest("[data-slot='breadcrumb-page']")
    expect(pageSlot).toHaveAttribute("aria-current", "page")

    expect(document.querySelector("[data-slot='breadcrumb-link']")).not.toBeInTheDocument()
    expect(document.querySelector("[data-slot='breadcrumb-separator']")).not.toBeInTheDocument()
  })

  // 3 — Two items (link + page + separator + a11y + typography)

  // 3.1
  it("[tag:breadcrumb][tag:rendering][tag:a11y][tag:typography] should render link and page with separator, a11y attrs, and Typography", () => {
    const { container } = renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Settings", href: "/settings" },
    ])

    const link = screen.getByText("Home").closest("[data-slot='breadcrumb-link']")
    expect(link).toBeInTheDocument()
    expect(link).toHaveAttribute("href", "/")

    const linkText = screen.getByText("Home")
    expect(linkText.tagName).toBe("SPAN")

    const page = screen.getByText("Settings").closest("[data-slot='breadcrumb-page']")
    expect(page).toHaveAttribute("aria-current", "page")

    const pageText = screen.getByText("Settings")
    expect(pageText.tagName).toBe("SPAN")

    const separators = container.querySelectorAll("[data-slot='breadcrumb-separator']")
    expect(separators).toHaveLength(1)
  })

  // 4 — Three items (link + link + page)

  // 4.1
  it("[tag:breadcrumb][tag:rendering] should render first two as links and last as page with separators", () => {
    const { container } = renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Docs", href: "/docs" },
      { label: "API", href: "/docs/api" },
    ])

    const homeLink = screen.getByText("Home").closest("[data-slot='breadcrumb-link']")
    expect(homeLink).toHaveAttribute("href", "/")

    const docsLink = screen.getByText("Docs").closest("[data-slot='breadcrumb-link']")
    expect(docsLink).toHaveAttribute("href", "/docs")

    const page = screen.getByText("API").closest("[data-slot='breadcrumb-page']")
    expect(page).toHaveAttribute("aria-current", "page")

    const separators = container.querySelectorAll("[data-slot='breadcrumb-separator']")
    expect(separators).toHaveLength(2)
  })

  // 5 — Four+ items (link + ellipsis + page)

  // 5.1
  it("[tag:breadcrumb][tag:rendering] should collapse middle items into ellipsis when 4+ items", () => {
    const { container } = renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Section A", href: "/a" },
      { label: "Section B", href: "/b" },
      { label: "Current", href: "/current" },
    ])

    const homeLink = screen.getByText("Home").closest("[data-slot='breadcrumb-link']")
    expect(homeLink).toBeInTheDocument()

    const ellipsis = container.querySelector("[data-slot='breadcrumb-ellipsis']")
    expect(ellipsis).toBeInTheDocument()

    const page = screen.getByText("Current").closest("[data-slot='breadcrumb-page']")
    expect(page).toHaveAttribute("aria-current", "page")

    expect(screen.queryByText("Section A")).not.toBeInTheDocument()
    expect(screen.queryByText("Section B")).not.toBeInTheDocument()
  })

  // 5.2
  it("[tag:breadcrumb][tag:dropdownMenu][tag:ellipsis] should open dropdown with collapsed items on ellipsis click", async () => {
    const user = userEvent.setup()

    renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Section A", href: "/a" },
      { label: "Section B", href: "/b" },
      { label: "Current", href: "/current" },
    ])

    const trigger = screen.getByRole("button", { name: "Toggle collapsed breadcrumbs" })
    await user.click(trigger)

    expect(await screen.findByText("Section A")).toBeInTheDocument()
    expect(screen.getByText("Section B")).toBeInTheDocument()
  })

  // 5.3
  it("[tag:breadcrumb][tag:a11y][tag:ellipsis] should render collapsed dropdown items as links", async () => {
    const user = userEvent.setup()

    renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Section A", href: "/a" },
      { label: "Section B", href: "/b" },
      { label: "Current", href: "/current" },
    ])

    const trigger = screen.getByRole("button", { name: "Toggle collapsed breadcrumbs" })
    await user.click(trigger)

    const linkA = await screen.findByText("Section A")
    expect(linkA.closest("a")).toHaveAttribute("href", "/a")

    const linkB = screen.getByText("Section B")
    expect(linkB.closest("a")).toHaveAttribute("href", "/b")
  })

  // 6 — Separator and a11y

  // 6.1
  it("[tag:breadcrumb][tag:a11y] should set aria-hidden=true on all separators", () => {
    const { container } = renderBreadcrumb([
      { label: "Home", href: "/" },
      { label: "Docs", href: "/docs" },
      { label: "Current", href: "/current" },
    ])

    const separators = container.querySelectorAll("[data-slot='breadcrumb-separator']")
    separators.forEach((sep) => {
      expect(sep).toHaveAttribute("aria-hidden", "true")
    })
  })

})
