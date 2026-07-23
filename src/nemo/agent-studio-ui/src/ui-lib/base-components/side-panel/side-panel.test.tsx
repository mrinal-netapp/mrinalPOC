import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { userEvent } from "@test/render"
import { SidePanel } from "./side-panel"

describe("SidePanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("[tag:side-panel][tag:dialog] renders title, content, header action, footer, and custom classes", () => {
    const onOpenChange = vi.fn()

    render(
      <SidePanel
        open
        onOpenChange={onOpenChange}
        title="Panel title"
        headerAction={<button type="button">Header action</button>}
        footer={<button type="button">Footer action</button>}
        width={512}
        className="side-panel--custom"
        bodyClassName="side-panel__body--custom"
      >
        Panel body
      </SidePanel>,
    )

    const dialog = screen.getByRole("dialog", { name: "Panel title" })
    const body = screen.getByText("Panel body").closest(".side-panel__body")

    expect(dialog).toHaveClass("side-panel", "side-panel--custom")
    expect(dialog.style.getPropertyValue("--side-panel-width")).toBe("512px")
    expect(screen.getByText("Header action")).toBeInTheDocument()
    expect(screen.getByText("Footer action")).toBeInTheDocument()
    expect(body).toHaveClass("side-panel__body--custom")
  })

  it("[tag:side-panel][tag:dialog] omits optional header action and footer when not provided", () => {
    render(
      <SidePanel open onOpenChange={vi.fn()} title="Simple panel">
        Simple body
      </SidePanel>,
    )

    expect(screen.getByRole("dialog", { name: "Simple panel" })).toBeInTheDocument()
    expect(screen.getByText("Simple body")).toBeInTheDocument()
    expect(document.querySelector(".side-panel__header-action")).not.toBeInTheDocument()
    expect(document.querySelector(".side-panel__footer")).not.toBeInTheDocument()
  })

  it("[tag:side-panel][tag:dialog] requests close when Escape is pressed", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(
      <SidePanel open onOpenChange={onOpenChange} title="Closable panel">
        Closable body
      </SidePanel>,
    )

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false, expect.any(KeyboardEvent), "escape-key")
    })
  })

  it("[tag:side-panel][tag:dialog] requests close when the close button is clicked", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(
      <SidePanel open onOpenChange={onOpenChange} title="Closable panel">
        Closable body
      </SidePanel>,
    )

    await user.click(screen.getByRole("button", { name: "Close" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("[tag:side-panel] falls back to a null portal container when document is unavailable", () => {
    vi.stubGlobal("document", undefined)

    expect(() =>
      SidePanel({
        open: false,
        onOpenChange: vi.fn(),
        title: "Server panel",
        children: "Server body",
      }),
    ).not.toThrow()
  })
})
