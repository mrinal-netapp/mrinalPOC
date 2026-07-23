import * as React from "react"
import { screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import {
  DEFAULT_ADD_LABEL,
  DEFAULT_CANCEL_LABEL,
  DEFAULT_CLOSE_ARIA_LABEL,
} from "./add-entity-form.consts"
import { AddEntityForm } from "./add-entity-form"

const baseProps = {
  open: true,
  title: "Add tool",
  entityName: "My tool",
  entityDescription: "A sample description.",
  onAdd: vi.fn(),
  onCancel: vi.fn(),
  sections: [<button key="body" type="button">Body button</button>],
}

beforeEach(() => {
  baseProps.onAdd = vi.fn()
  baseProps.onCancel = vi.fn()
})

describe("AddEntityForm — rendering & defaults", () => {
  it("[tag:add-entity-form] returns null when closed", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} open={false} />)
    expect(container.querySelector(".add-entity-form")).toBeNull()
  })

  it("[tag:add-entity-form] renders the form panel when open", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    expect(container.querySelector(".add-entity-form")).not.toBeNull()
  })

  it("[tag:add-entity-form] renders title, entityName, and entityDescription when provided", () => {
    renderWithProviders(<AddEntityForm {...baseProps} />)
    expect(screen.getByText("Add tool")).toBeInTheDocument()
    expect(screen.getByText("My tool")).toBeInTheDocument()
    expect(screen.getByText("A sample description.")).toBeInTheDocument()
  })

  it("[tag:add-entity-form] omits the entity heading block when entityName is not provided", () => {
    renderWithProviders(
      <AddEntityForm {...baseProps} entityName={undefined} entityDescription={undefined} />,
    )
    expect(screen.queryByText("My tool")).not.toBeInTheDocument()
    expect(screen.queryByText("A sample description.")).not.toBeInTheDocument()
  })

  it("[tag:add-entity-form] renders only the heading when entityName is set but entityDescription is omitted", () => {
    renderWithProviders(<AddEntityForm {...baseProps} entityDescription={undefined} />)
    expect(screen.getByText("My tool")).toBeInTheDocument()
    expect(screen.queryByText("A sample description.")).not.toBeInTheDocument()
  })

  it("[tag:add-entity-form] uses default labels 'Add' and 'Cancel'", () => {
    renderWithProviders(<AddEntityForm {...baseProps} />)
    expect(screen.getByRole("button", { name: DEFAULT_ADD_LABEL })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: DEFAULT_CANCEL_LABEL })).toBeInTheDocument()
  })

  it("[tag:add-entity-form] uses custom addLabel and cancelLabel when provided", () => {
    renderWithProviders(
      <AddEntityForm {...baseProps} addLabel="Save" cancelLabel="Dismiss" />,
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument()
  })

  it("[tag:add-entity-form] uses the default close button aria-label", () => {
    renderWithProviders(<AddEntityForm {...baseProps} />)
    expect(screen.getByRole("button", { name: DEFAULT_CLOSE_ARIA_LABEL })).toBeInTheDocument()
  })

  it("[tag:add-entity-form] uses a custom closeAriaLabel when provided", () => {
    renderWithProviders(<AddEntityForm {...baseProps} closeAriaLabel="Shut" />)
    expect(screen.getByRole("button", { name: "Shut" })).toBeInTheDocument()
  })

  it("[tag:add-entity-form] exposes dialog semantics labelled by the title", () => {
    /*
     * A11Y-001 — The form is announced as a dialog. role="dialog" lets
     * screen readers know they're in a modal surface; aria-modal="true"
     * tells them content outside is inert; aria-labelledby points at the
     * h2 title id so the dialog's accessible name matches what's painted
     * at the top of the form.
     */
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    const dialog = container.querySelector<HTMLElement>(".add-entity-form")
    expect(dialog).not.toBeNull()
    expect(dialog).toHaveAttribute("role", "dialog")
    expect(dialog).toHaveAttribute("aria-modal", "true")

    const labelledBy = dialog?.getAttribute("aria-labelledby")
    expect(labelledBy).toBeTruthy()
    const titleEl = labelledBy ? container.querySelector(`#${labelledBy}`) : null
    expect(titleEl).not.toBeNull()
    expect(titleEl).toHaveTextContent("Add tool")
  })

  it("[tag:add-entity-form] wires aria-describedby to the description when one is rendered", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    const dialog = container.querySelector<HTMLElement>(".add-entity-form")
    const describedBy = dialog?.getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()
    const descEl = describedBy ? container.querySelector(`#${describedBy}`) : null
    expect(descEl).not.toBeNull()
    expect(descEl).toHaveTextContent("A sample description.")
  })

  it("[tag:add-entity-form] omits aria-describedby when no description is passed", () => {
    /*
     * A dangling aria-describedby that points at a non-existent node is
     * worse than no attribute at all — screen readers either announce
     * nothing or fall back to verbose URI text. Omit it cleanly.
     */
    const { container } = renderWithProviders(
      <AddEntityForm {...baseProps} entityDescription={undefined} />,
    )
    const dialog = container.querySelector<HTMLElement>(".add-entity-form")
    expect(dialog).not.toHaveAttribute("aria-describedby")
  })

  it("[tag:add-entity-form] omits aria-describedby when description is set but entityName is not", () => {
    /*
     * Regression for the "dangling aria-describedby" bug: the
     * description paragraph is nested inside the entityName block, so a
     * caller passing a description without a name would previously have
     * left aria-describedby pointing at an id that was never rendered.
     * The component must gate aria-describedby on the same condition
     * that gates the description node itself.
     */
    const { container } = renderWithProviders(
      <AddEntityForm
        {...baseProps}
        entityName={undefined}
        entityDescription="Orphan description"
      />,
    )
    const dialog = container.querySelector<HTMLElement>(".add-entity-form")
    expect(dialog).not.toHaveAttribute("aria-describedby")
    expect(screen.queryByText("Orphan description")).not.toBeInTheDocument()
  })

  it("[tag:add-entity-form] renders sections inside the body", () => {
    renderWithProviders(
      <AddEntityForm
        {...baseProps}
        sections={[<div key="child" data-testid="child">Body content</div>]}
      />,
    )
    expect(screen.getByTestId("child")).toBeInTheDocument()
  })

  it("[tag:add-entity-form] renders ordered sections in the body", () => {
    renderWithProviders(
      <AddEntityForm
        {...baseProps}
        sections={[
          <div key="a" data-testid="section-a">Section A</div>,
          <div key="b" data-testid="section-b">Section B</div>,
        ]}
      />,
    )
    const sectionA = screen.getByTestId("section-a")
    const sectionB = screen.getByTestId("section-b")
    expect(sectionA).toBeInTheDocument()
    expect(sectionB).toBeInTheDocument()
    expect(sectionA.compareDocumentPosition(sectionB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("[tag:add-entity-form] falls back to an index-based key for non-element sections", () => {
    /*
     * `Children.toArray` auto-keys React elements but leaves primitives
     * (string, number) as themselves. The component falls back to an
     * index-based key when `isValidElement(section)` is false so the map's
     * `key` prop is always populated. This test exercises that fallback
     * branch — without it, branch coverage drops below the 100% threshold
     * the project enforces on `src/components/common/**`.
     */
    renderWithProviders(
      <AddEntityForm {...baseProps} sections={["Plain text section", 42]} />,
    )
    expect(screen.getByText("Plain text section")).toBeInTheDocument()
    expect(screen.getByText("42")).toBeInTheDocument()
  })

  it("[tag:add-entity-form] filters null and undefined entries from sections", () => {
    renderWithProviders(
      <AddEntityForm
        {...baseProps}
        sections={[
          null,
          <div key="real" data-testid="real">Real section</div>,
          undefined,
        ]}
      />,
    )
    expect(screen.getByTestId("real")).toBeInTheDocument()
  })

  it("[tag:add-entity-form] renders without crashing when sections is undefined", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} sections={undefined} />)
    expect(container.querySelector(".add-entity-form")).not.toBeNull()
  })

  it("[tag:add-entity-form] preserves caller-supplied section keys across re-renders", async () => {
    /*
     * Regression test for the "index-based keys remount sections" bug.
     * If keys are taken from the section's index (the buggy behaviour),
     * prepending a new section makes the existing one shift index, get a
     * different key, remount, and lose internal state. With caller keys
     * preserved, the section keeps its identity and its state.
     */
    function StatefulSection({ id }: { id: string }): React.ReactElement {
      const [value, setValue] = React.useState("")
      return (
        <input
          data-testid={`stateful-${id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )
    }

    const { rerender } = renderWithProviders(
      <AddEntityForm
        {...baseProps}
        sections={[<StatefulSection key="b" id="b" />]}
      />,
    )

    const user = userEvent.setup()
    await user.type(screen.getByTestId("stateful-b"), "hello")
    expect(screen.getByTestId("stateful-b")).toHaveValue("hello")

    rerender(
      <AddEntityForm
        {...baseProps}
        sections={[
          <StatefulSection key="a" id="a" />,
          <StatefulSection key="b" id="b" />,
        ]}
      />,
    )

    // If keys were index-based, "b" would have remounted (its index moved
    // from 0 to 1) and the input would now be empty.
    expect(screen.getByTestId("stateful-b")).toHaveValue("hello")
  })
})

describe("AddEntityForm — primary actions", () => {
  it("[tag:add-entity-form] calls onCancel when the close X button is clicked", async () => {
    const onCancel = vi.fn()
    renderWithProviders(<AddEntityForm {...baseProps} onCancel={onCancel} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Close dialog" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("[tag:add-entity-form] calls onCancel when the Cancel button is clicked", async () => {
    const onCancel = vi.fn()
    renderWithProviders(<AddEntityForm {...baseProps} onCancel={onCancel} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalled()
  })

  it("[tag:add-entity-form] calls onAdd when the primary add button is clicked", async () => {
    const onAdd = vi.fn()
    renderWithProviders(<AddEntityForm {...baseProps} onAdd={onAdd} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Add" }))
    expect(onAdd).toHaveBeenCalled()
  })
})

describe("AddEntityForm — focus management (A11Y-004)", () => {
  it("[tag:add-entity-form] moves focus into the panel when opened", () => {
    renderWithProviders(<AddEntityForm {...baseProps} />)
    const closeButton = screen.getByRole("button", { name: "Close dialog" })
    expect(document.activeElement).toBe(closeButton)
  })

  it("[tag:add-entity-form] restores focus to the trigger element on close", () => {
    const trigger = document.createElement("button")
    trigger.textContent = "Open"
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { unmount } = renderWithProviders(<AddEntityForm {...baseProps} />)
    expect(document.activeElement).not.toBe(trigger)

    unmount()
    expect(document.activeElement).toBe(trigger)

    document.body.removeChild(trigger)
  })

  it("[tag:add-entity-form] closes on Escape via onCancel", () => {
    const onCancel = vi.fn()
    const { container } = renderWithProviders(
      <AddEntityForm {...baseProps} onCancel={onCancel} />,
    )
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    fireEvent.keyDown(panel, { key: "Escape" })
    expect(onCancel).toHaveBeenCalled()
  })

  it("[tag:add-entity-form] Tab from the last focusable wraps to the first", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    last.focus()
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(panel, { key: "Tab" })
    expect(document.activeElement).toBe(first)
  })

  it("[tag:add-entity-form] Shift+Tab from the first focusable wraps to the last", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    first.focus()
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it("[tag:add-entity-form] Tab in the middle of the focus order does not wrap", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    expect(focusables.length).toBeGreaterThan(2)
    const middle = focusables[1]
    middle.focus()
    fireEvent.keyDown(panel, { key: "Tab" })
    // Default browser tab behaviour isn't simulated, so focus stays put; the
    // important assertion is that no wrap occurred (i.e. focus is not on first/last).
    expect(document.activeElement).toBe(middle)
  })

  it("[tag:add-entity-form] non-Tab / non-Escape keys are ignored", () => {
    const onCancel = vi.fn()
    const { container } = renderWithProviders(
      <AddEntityForm {...baseProps} onCancel={onCancel} />,
    )
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    fireEvent.keyDown(panel, { key: "Enter" })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("[tag:add-entity-form] Tab no-op path runs without throwing when most focusables are disabled", () => {
    const onCancel = vi.fn()
    const { container } = renderWithProviders(
      <AddEntityForm
        {...baseProps}
        onCancel={onCancel}
        sections={[<div key="nf">no focusables</div>]}
      />,
    )
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    // Disable every focusable element we can reach inside the panel so the
    // Tab handler exercises the "elements.length === 0" early-return branch
    // when the focusable selector returns nothing.
    panel
      .querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]',
      )
      .forEach((el) => {
        el.setAttribute("disabled", "")
        el.setAttribute("tabindex", "-1")
      })

    expect(() => fireEvent.keyDown(panel, { key: "Tab" })).not.toThrow()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it("[tag:add-entity-form] Shift+Tab in the middle of the focus order does not wrap", () => {
    const { container } = renderWithProviders(<AddEntityForm {...baseProps} />)
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    expect(focusables.length).toBeGreaterThan(2)
    const middle = focusables[1]
    middle.focus()
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(middle)
  })

  it("[tag:add-entity-form] does not restore focus when trigger element is no longer in the DOM", () => {
    const detachedTrigger = document.createElement("div")
    detachedTrigger.tabIndex = 0
    document.body.appendChild(detachedTrigger)
    detachedTrigger.focus()
    expect(document.activeElement).toBe(detachedTrigger)

    const { unmount } = renderWithProviders(<AddEntityForm {...baseProps} />)
    document.body.removeChild(detachedTrigger)
    expect(() => unmount()).not.toThrow()
  })

  it("[tag:add-entity-form] re-rendering with a new onCancel does not steal focus from the active control", () => {
    const onCancel1 = vi.fn()
    const onCancel2 = vi.fn()
    const { rerender, container } = renderWithProviders(
      <AddEntityForm {...baseProps} onCancel={onCancel1} />,
    )
    const panel = container.querySelector(".add-entity-form") as HTMLElement
    const focusables = panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    // Simulate the user moving focus to a control mid-interaction (Cancel
    // button), then a parent re-render passing a fresh onCancel identity.
    const cancelBtn = Array.from(focusables).find((el) => el.textContent === "Cancel") as HTMLElement
    cancelBtn.focus()
    expect(document.activeElement).toBe(cancelBtn)

    rerender(<AddEntityForm {...baseProps} onCancel={onCancel2} />)
    // Focus must remain where the user left it; the focus-management effect
    // should not have torn down and reset focus to the close button.
    expect(document.activeElement).toBe(cancelBtn)

    // The new onCancel must take effect — Escape should call onCancel2, not onCancel1.
    fireEvent.keyDown(panel, { key: "Escape" })
    expect(onCancel1).not.toHaveBeenCalled()
    expect(onCancel2).toHaveBeenCalled()
  })

  it("[tag:add-entity-form] does not restore focus when the trigger is not an HTMLElement (SVG)", () => {
    const svgTrigger = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svgTrigger.setAttribute("tabindex", "0")
    document.body.appendChild(svgTrigger)
    ;(svgTrigger as unknown as HTMLElement).focus()

    const focusSpy = vi.spyOn(svgTrigger, "focus" as never)
    const { unmount } = renderWithProviders(<AddEntityForm {...baseProps} />)
    unmount()

    expect(focusSpy).not.toHaveBeenCalled()
    document.body.removeChild(svgTrigger)
  })
})
