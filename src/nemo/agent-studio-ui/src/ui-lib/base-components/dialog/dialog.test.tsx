import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, afterEach } from "vitest"
import React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { renderWithProviders, userEvent } from "@test/render"

import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogBackdrop,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./dialog"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderOpenDialog(props?: Partial<React.ComponentProps<typeof Dialog>>) {
  return renderWithProviders(
    <Dialog open={true} {...props}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Test Title</DialogTitle>
          <DialogDescription>Test Description</DialogDescription>
        </DialogHeader>
        <p>Dialog body</p>
        <DialogFooter>
          <DialogClose />
        </DialogFooter>
      </DialogPopup>
    </Dialog>,
  )
}

// ---------------------------------------------------------------------------
// 1 — Core rendering and open/close
// ---------------------------------------------------------------------------

describe("Dialog", () => {
  describe("core rendering and open/close", () => {
    // 1.1
    it("[tag:dialog][tag:closed][tag:trigger] should render trigger but not popup content when closed by default", () => {
      renderWithProviders(
        <Dialog>
          <DialogTrigger label="Open" />
          <DialogPopup>Hidden content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument()
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      expect(screen.queryByText("Hidden content")).not.toBeInTheDocument()
    })

    // 1.2
    it("[tag:dialog][tag:open][tag:default-open] should render open immediately when isDefaultOpen is true", () => {
      renderWithProviders(
        <Dialog isDefaultOpen={true}>
          <DialogTrigger label="Open" />
          <DialogPopup>
            <p>Visible content</p>
          </DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByText("Visible content")).toBeInTheDocument()
    })

    // 1.3
    it("[tag:dialog][tag:controlled][tag:open] should render popup when open is true", () => {
      renderOpenDialog()

      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByText("Dialog body")).toBeInTheDocument()
    })

    // 1.4
    it("[tag:dialog][tag:controlled][tag:closed] should not render popup when open is false", () => {
      renderWithProviders(
        <Dialog open={false}>
          <DialogPopup>Should not show</DialogPopup>
        </Dialog>,
      )

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    // 1.5
    it("[tag:dialog][tag:uncontrolled][tag:open] should open when trigger is clicked", async () => {
      const user = userEvent.setup()

      renderWithProviders(
        <Dialog>
          <DialogTrigger label="Open" />
          <DialogPopup>
            <p>Popup content</p>
          </DialogPopup>
        </Dialog>,
      )

      await user.click(screen.getByRole("button", { name: "Open" }))

      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByText("Popup content")).toBeInTheDocument()
    })

    // 1.6
    it("[tag:dialog][tag:uncontrolled][tag:close] should close when close button is clicked", async () => {
      const user = userEvent.setup()

      renderWithProviders(
        <Dialog isDefaultOpen={true}>
          <DialogTrigger label="Open" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("dialog")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Close dialog" }))

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      })
    })

    // 1.7
    it("[tag:dialog][tag:controlled][tag:onOpenChange] should fire onOpenChange on close attempt via close button", async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()

      renderWithProviders(
        <Dialog open={true} onOpenChange={handleChange}>
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      await user.click(screen.getByRole("button", { name: "Close dialog" }))

      expect(handleChange).toHaveBeenCalledWith(false, expect.anything(), "close-press")
    })

    // 1.8
    it("[tag:dialog][tag:controlled][tag:onOpenChange][tag:open] should fire onOpenChange with true when trigger is clicked", async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()

      renderWithProviders(
        <Dialog open={false} onOpenChange={handleChange}>
          <DialogTrigger label="Open" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      await user.click(screen.getByRole("button", { name: "Open" }))

      expect(handleChange).toHaveBeenCalledWith(true, expect.anything(), expect.anything())
    })
  })

  // ---------------------------------------------------------------------------
  // 2 — Dismissal behavior
  // ---------------------------------------------------------------------------

  describe("dismissal behavior", () => {
    // 2.1
    it("[tag:dialog][tag:escape] should close on Escape by default", async () => {
      const user = userEvent.setup()

      renderWithProviders(
        <Dialog isDefaultOpen={true}>
          <DialogTrigger label="Open" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("dialog")).toBeInTheDocument()

      await user.keyboard("{Escape}")

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      })
    })

    // 2.2
    it("[tag:dialog][tag:escape][tag:disabled] should stay open and not fire onOpenChange when isEscapeDisabled is true", async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()

      renderWithProviders(
        <Dialog open={true} onOpenChange={handleChange} isEscapeDisabled={true}>
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      await user.keyboard("{Escape}")

      expect(handleChange).not.toHaveBeenCalled()
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })

    // 2.3
    it("[tag:dialog][tag:escape][tag:controlled] should fire onOpenChange with escape-key reason when escape is not disabled", async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()

      renderWithProviders(
        <Dialog open={true} onOpenChange={handleChange}>
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      await user.keyboard("{Escape}")

      expect(handleChange).toHaveBeenCalledWith(false, expect.anything(), "escape-key")
    })

    // 2.4
    it("[tag:dialog][tag:escape][tag:disabled][tag:close-press] should still fire onOpenChange for non-escape close when isEscapeDisabled is true", async () => {
      const user = userEvent.setup()
      const handleChange = vi.fn()

      renderWithProviders(
        <Dialog open={true} onOpenChange={handleChange} isEscapeDisabled={true}>
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      await user.click(screen.getByRole("button", { name: "Close dialog" }))

      expect(handleChange).toHaveBeenCalledWith(false, expect.anything(), "close-press")
    })

    // 2.5
    it("[tag:dialog][tag:outside-click] should close when backdrop is clicked and isDismissOnOutsideClick is true", async () => {
      const user = userEvent.setup()

      renderWithProviders(
        <Dialog isDefaultOpen={true} isDismissOnOutsideClick={true}>
          <DialogTrigger label="Open" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("dialog")).toBeInTheDocument()

      const backdrop = document.querySelector(".dialog-backdrop")!
      await user.click(backdrop)

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
      })
    })

    // 2.6
    it("[tag:dialog][tag:outside-click][tag:disabled] should stay open when backdrop is clicked and isDismissOnOutsideClick is false", async () => {
      const user = userEvent.setup()

      renderWithProviders(
        <Dialog isDefaultOpen={true} isDismissOnOutsideClick={false}>
          <DialogTrigger label="Open" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      const backdrop = document.querySelector(".dialog-backdrop")!
      await user.click(backdrop)

      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })

    // 2.7
    it("[tag:dialog][tag:backdrop][tag:hasBackdrop] should render backdrop when hasBackdrop is true", () => {
      renderOpenDialog({ hasBackdrop: true })

      expect(document.querySelector(".dialog-backdrop")).toBeInTheDocument()
    })

    // 2.8
    it("[tag:dialog][tag:backdrop][tag:no-backdrop] should not render backdrop when hasBackdrop is false", () => {
      renderOpenDialog({ hasBackdrop: false })

      expect(document.querySelector(".dialog-backdrop")).not.toBeInTheDocument()
    })

    // 2.9
    it("[tag:dialog][tag:backdrop][tag:animation][tag:fade] should apply fade animation class to backdrop", () => {
      renderOpenDialog({ backdropAnimation: "fade" })

      expect(document.querySelector(".dialog-backdrop")).toHaveClass(
        "dialog-backdrop--animation-fade",
      )
    })

    // 2.10
    it("[tag:dialog][tag:backdrop][tag:animation][tag:none] should apply none animation class to backdrop", () => {
      renderOpenDialog({ backdropAnimation: "none" })

      expect(document.querySelector(".dialog-backdrop")).toHaveClass(
        "dialog-backdrop--animation-none",
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 3 — Trigger tests
  // ---------------------------------------------------------------------------

  describe("trigger", () => {
    // 3.1
    it("[tag:dialog-trigger][tag:button] should render Button by default with forwarded variant, size, and label", () => {
      renderWithProviders(
        <Dialog>
          <DialogTrigger label="My Label" variant="outline" size="small" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      const trigger = screen.getByRole("button", { name: "My Label" })
      expect(trigger).toBeInTheDocument()
      expect(trigger).toHaveClass("btn-variant-outline")
      expect(trigger).toHaveClass("btn-size-small")
    })

    // 3.2
    it("[tag:dialog-trigger][tag:button][tag:defaults] should default to solid variant and large size", () => {
      renderWithProviders(
        <Dialog>
          <DialogTrigger label="Default" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      const trigger = screen.getByRole("button", { name: "Default" })
      expect(trigger).toHaveClass("btn-variant-solid")
      expect(trigger).toHaveClass("btn-size-large")
    })

    // 3.3
    it("[tag:dialog-trigger][tag:button][tag:icon] should forward icon to default Button", () => {
      renderWithProviders(
        <Dialog>
          <DialogTrigger label="With Icon" icon={<svg data-testid="trigger-icon" />} />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByTestId("trigger-icon")).toBeInTheDocument()
    })

    // 3.4
    it("[tag:dialog-trigger][tag:button][tag:className] should forward className to default Button", () => {
      renderWithProviders(
        <Dialog>
          <DialogTrigger label="Custom Class" className="my-trigger" />
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("button", { name: "Custom Class" })).toHaveClass("my-trigger")
    })

    // 3.5
    it("[tag:dialog-trigger][tag:custom] should render custom triggerComponent and open dialog on click", async () => {
      const user = userEvent.setup()

      renderWithProviders(
        <Dialog>
          <DialogTrigger triggerComponent={<span data-testid="custom-trigger">Custom</span>} />
          <DialogPopup>Custom trigger content</DialogPopup>
        </Dialog>,
      )

      const trigger = screen.getByTestId("custom-trigger")
      expect(trigger).toBeInTheDocument()
      expect(trigger).toHaveTextContent("Custom")

      await user.click(trigger)

      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })

    // 3.6
    it("[tag:dialog-trigger][tag:detached] should open dialog via handle from trigger outside Root", async () => {
      const user = userEvent.setup()

      function DetachedTest() {
        const handle = React.useMemo(() => DialogPrimitive.createHandle(), [])
        return (
          <>
            <DialogPrimitive.Trigger
              handle={handle}
              render={<button type="button">Detached</button>}
            />
            <Dialog handle={handle}>
              <DialogPopup>Detached content</DialogPopup>
            </Dialog>
          </>
        )
      }

      renderWithProviders(<DetachedTest />)

      await user.click(screen.getByRole("button", { name: "Detached" }))

      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByText("Detached content")).toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // 4 — Size variants
  // ---------------------------------------------------------------------------

  describe("size variants", () => {
    // 4.1
    it.each([
      ["sm", "dialog-popup--size-sm"],
      ["md", "dialog-popup--size-md"],
      ["lg", "dialog-popup--size-lg"],
      ["full", "dialog-popup--size-full"],
    ] as const)(
      "[tag:dialog-popup][tag:%s] should apply %s class",
      (size, expectedClass) => {
        renderWithProviders(
          <Dialog open={true} size={size}>
            <DialogPopup>Content</DialogPopup>
          </Dialog>,
        )

        expect(screen.getByRole("dialog")).toHaveClass(expectedClass)
      },
    )

    // 4.2
    it("[tag:dialog-popup][tag:size][tag:override] should allow popup-level size to override root size", () => {
      renderWithProviders(
        <Dialog open={true} size="md">
          <DialogPopup size="lg">Content</DialogPopup>
        </Dialog>,
      )

      const popup = screen.getByRole("dialog")
      expect(popup).toHaveClass("dialog-popup--size-lg")
      expect(popup).not.toHaveClass("dialog-popup--size-md")
    })
  })

  // ---------------------------------------------------------------------------
  // 5 — Animation variants
  // ---------------------------------------------------------------------------

  describe("animation variants", () => {
    // 5.1
    it.each([
      ["fade", "dialog-popup--animation-fade"],
      ["scale", "dialog-popup--animation-scale"],
      ["slideUp", "dialog-popup--animation-slideUp"],
    ] as const)(
      "[tag:dialog-popup][tag:animation][tag:%s] should apply %s class",
      (animation, expectedClass) => {
        renderWithProviders(
          <Dialog open={true} animation={animation}>
            <DialogPopup>Content</DialogPopup>
          </Dialog>,
        )

        expect(screen.getByRole("dialog")).toHaveClass(expectedClass)
      },
    )

    // 5.2
    it("[tag:dialog-popup][tag:animation][tag:override] should allow popup-level animation to override root animation", () => {
      renderWithProviders(
        <Dialog open={true} animation="fade">
          <DialogPopup animation="scale">Content</DialogPopup>
        </Dialog>,
      )

      const popup = screen.getByRole("dialog")
      expect(popup).toHaveClass("dialog-popup--animation-scale")
      expect(popup).not.toHaveClass("dialog-popup--animation-fade")
    })
  })

  // ---------------------------------------------------------------------------
  // 6 — Popup options
  // ---------------------------------------------------------------------------

  describe("popup options", () => {
    // 6.1
    it("[tag:dialog-popup][tag:className] should forward custom className to popup", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup className="my-popup">Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("dialog")).toHaveClass("my-popup")
    })

    // 6.2
    it("[tag:dialog-popup][tag:close-button] should render close button by default", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("button", { name: "Close dialog" })).toBeInTheDocument()
    })

    // 6.3
    it("[tag:dialog-popup][tag:close-button][tag:hidden] should not render close button when showCloseButton is false", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup showCloseButton={false}>Content</DialogPopup>
        </Dialog>,
      )

      expect(screen.queryByRole("button", { name: "Close dialog" })).not.toBeInTheDocument()
    })

    // 6.4
    it("[tag:dialog-popup][tag:ref] should forward ref to the popup element", () => {
      const ref = React.createRef<HTMLDivElement>()

      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup ref={ref}>Content</DialogPopup>
        </Dialog>,
      )

      expect(ref.current).toBe(screen.getByRole("dialog"))
    })
  })

  // ---------------------------------------------------------------------------
  // 7 — Sub-components
  // ---------------------------------------------------------------------------

  describe("sub-components", () => {
    // 7.1
    it("[tag:dialog-header][tag:dialog-footer][tag:dialog-title][tag:dialog-description][tag:dialog-close] should render all sub-components with correct default classes and attributes", () => {
      renderOpenDialog()

      const header = document.querySelector("[data-slot='dialog-header']")
      expect(header).toBeInTheDocument()
      expect(header).toHaveClass("dialog-header")

      const footer = document.querySelector("[data-slot='dialog-footer']")
      expect(footer).toBeInTheDocument()
      expect(footer).toHaveClass("dialog-footer")

      expect(screen.getByText("Test Title")).toHaveClass("dialog-title")
      expect(screen.getByText("Test Description")).toHaveClass("dialog-description")

      const closeButtons = screen.getAllByRole("button", { name: "Close dialog" })
      expect(closeButtons.length).toBeGreaterThanOrEqual(1)
      expect(closeButtons[0]).toHaveAttribute("aria-label", "Close dialog")
    })

    // 7.2
    it("[tag:dialog-header][tag:className] should forward custom className", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>
            <DialogHeader className="custom-header">Header content</DialogHeader>
          </DialogPopup>
        </Dialog>,
      )

      expect(document.querySelector("[data-slot='dialog-header']")).toHaveClass(
        "dialog-header",
        "custom-header",
      )
    })

    // 7.3
    it("[tag:dialog-footer][tag:className] should forward custom className", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>
            <DialogFooter className="custom-footer">Footer content</DialogFooter>
          </DialogPopup>
        </Dialog>,
      )

      expect(document.querySelector("[data-slot='dialog-footer']")).toHaveClass(
        "dialog-footer",
        "custom-footer",
      )
    })

    // 7.4
    it("[tag:dialog-title][tag:className] should forward custom className", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>
            <DialogTitle className="custom-title">Title</DialogTitle>
          </DialogPopup>
        </Dialog>,
      )

      expect(screen.getByText("Title")).toHaveClass("dialog-title", "custom-title")
    })

    // 7.5
    it("[tag:dialog-description][tag:className] should forward custom className", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>
            <DialogDescription className="custom-desc">Desc</DialogDescription>
          </DialogPopup>
        </Dialog>,
      )

      expect(screen.getByText("Desc")).toHaveClass("dialog-description", "custom-desc")
    })

    // 7.6
    it("[tag:dialog-close][tag:label][tag:custom] should use custom label for aria-label", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup showCloseButton={false}>
            <DialogClose label="Dismiss" />
          </DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument()
    })

    // 7.7
    it("[tag:dialog-close][tag:className] should forward custom className and include dialog-close base class", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup showCloseButton={false}>
            <DialogClose className="my-close" />
          </DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("button", { name: "Close dialog" })).toHaveClass(
        "dialog-close",
        "my-close",
      )
    })
  })

  // ---------------------------------------------------------------------------
  // 8 — Accessibility
  // ---------------------------------------------------------------------------

  describe("accessibility", () => {
    // 8.1
    it("[tag:dialog][tag:a11y][tag:role] should have role=dialog on popup", () => {
      renderOpenDialog()

      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })

    // 8.2
    it("[tag:dialog][tag:a11y][tag:modal] should apply aria-hidden to content behind the modal dialog", () => {
      renderOpenDialog()

      const inertElements = document.querySelectorAll("[aria-hidden='true'][data-base-ui-inert]")
      expect(inertElements.length).toBeGreaterThanOrEqual(1)
    })

    // 8.3
    it("[tag:dialog][tag:a11y][tag:aria-labelledby][tag:aria-describedby] should wire aria-labelledby to DialogTitle and aria-describedby to DialogDescription", () => {
      renderOpenDialog()

      const popup = screen.getByRole("dialog")

      const titleId = screen.getByText("Test Title").getAttribute("id")
      expect(titleId).toBeTruthy()
      expect(popup).toHaveAttribute("aria-labelledby", titleId)

      const descId = screen.getByText("Test Description").getAttribute("id")
      expect(descId).toBeTruthy()
      expect(popup).toHaveAttribute("aria-describedby", descId)
    })
  })

  // ---------------------------------------------------------------------------
  // 9 — Portal container
  // ---------------------------------------------------------------------------

  describe("portal container", () => {
    let portalTarget: HTMLElement | null = null

    afterEach(() => {
      if (portalTarget && portalTarget.parentNode) {
        portalTarget.parentNode.removeChild(portalTarget)
        portalTarget = null
      }
    })

    // 9.1
    it("[tag:dialog-popup][tag:portal] should render into data-slot=main-content when available", () => {
      portalTarget = document.createElement("div")
      portalTarget.setAttribute("data-slot", "main-content")
      document.body.appendChild(portalTarget)

      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>Portal content</DialogPopup>
        </Dialog>,
      )

      expect(portalTarget.querySelector("[role='dialog']")).toBeInTheDocument()
    })

    // 9.2
    it("[tag:dialog-popup][tag:portal][tag:container] should use explicit container prop over main-content element", () => {
      portalTarget = document.createElement("div")
      portalTarget.setAttribute("data-testid", "custom-container")
      document.body.appendChild(portalTarget)

      const mainContent = document.createElement("div")
      mainContent.setAttribute("data-slot", "main-content")
      document.body.appendChild(mainContent)

      renderWithProviders(
        <Dialog open={true} container={portalTarget}>
          <DialogPopup>Custom portal</DialogPopup>
        </Dialog>,
      )

      expect(portalTarget.querySelector("[role='dialog']")).toBeInTheDocument()
      expect(mainContent.querySelector("[role='dialog']")).toBeNull()

      document.body.removeChild(mainContent)
    })

    // 9.3
    it("[tag:dialog-popup][tag:portal][tag:fallback] should render when no portal container is available", () => {
      renderWithProviders(
        <Dialog open={true}>
          <DialogPopup>Fallback content</DialogPopup>
        </Dialog>,
      )

      expect(screen.getByRole("dialog")).toBeInTheDocument()
      expect(screen.getByText("Fallback content")).toBeInTheDocument()
    })
  })

  // ---------------------------------------------------------------------------
  // 10 — DialogBackdrop (public)
  // ---------------------------------------------------------------------------

  describe("DialogBackdrop (public)", () => {
    // 10.1
    it("[tag:dialog-backdrop][tag:animation] should render with overridden animation class and custom className", () => {
      renderWithProviders(
        <Dialog open={true} hasBackdrop={false} backdropAnimation="none">
          <DialogBackdrop animation="fade" className="public-backdrop" />
          <DialogPopup showCloseButton={false}>Content</DialogPopup>
        </Dialog>,
      )

      const backdrop = document.querySelector(".public-backdrop")
      expect(backdrop).toBeInTheDocument()
      expect(backdrop).toHaveClass("dialog-backdrop--animation-fade")
    })

    // 10.2
    it("[tag:dialog-backdrop][tag:animation][tag:context] should fall back to context backdropAnimation when animation prop is omitted", () => {
      renderWithProviders(
        <Dialog open={true} hasBackdrop={false} backdropAnimation="none">
          <DialogBackdrop className="ctx-backdrop" />
          <DialogPopup showCloseButton={false}>Content</DialogPopup>
        </Dialog>,
      )

      const backdrop = document.querySelector(".ctx-backdrop")
      expect(backdrop).toBeInTheDocument()
      expect(backdrop).toHaveClass("dialog-backdrop--animation-none")
    })
  })
})
