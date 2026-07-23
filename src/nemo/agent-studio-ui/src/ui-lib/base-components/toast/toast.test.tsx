import { screen, waitFor } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Toaster } from "./toast.toaster"
import { toast } from "./toast"

// jsdom does not implement pointer capture APIs used by Sonner internally
const originalSetPointerCapture = Element.prototype.setPointerCapture
const originalReleasePointerCapture = Element.prototype.releasePointerCapture

beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterAll(() => {
  Element.prototype.setPointerCapture = originalSetPointerCapture
  Element.prototype.releasePointerCapture = originalReleasePointerCapture
})

// -- helpers

function renderToaster(overrides: { className?: string } = {}) {
  const { className } = overrides
  return renderWithProviders(<Toaster className={className} />)
}

// ===== Toast =====

describe("Toast", () => {
  // 1 — Rendering

  // 1.1
  it("[tag:toast][tag:rendering] should render a wrapper div with data-slot and BEM class", () => {
    const { container } = renderToaster()

    const wrapper = container.querySelector("[data-slot='sonner']")
    expect(wrapper).toBeInTheDocument()
    expect(wrapper?.tagName).toBe("DIV")
    expect(wrapper).toHaveClass("sonner-toaster")
  })

  // 1.2
  it("[tag:toast][tag:className] should forward className to wrapper div", () => {
    const { container } = renderToaster({ className: "my-custom-toaster" })

    const wrapper = container.querySelector("[data-slot='sonner']")
    expect(wrapper).toHaveClass("sonner-toaster", "my-custom-toaster")
  })

  // 2 — Exports

  // 2.1
  it("[tag:toast][tag:export] should export toast as a callable function", () => {
    expect(typeof toast).toBe("function")
  })

  // 2.2
  it("[tag:toast][tag:export] should export toast.success, toast.error, toast.warning, toast.info", () => {
    expect(typeof toast.success).toBe("function")
    expect(typeof toast.error).toBe("function")
    expect(typeof toast.warning).toBe("function")
    expect(typeof toast.info).toBe("function")
  })

  // 3 — Toast appearance in DOM

  // 3.1
  it("[tag:toast][tag:rendering] should display a default toast message in the DOM", async () => {
    renderToaster()
    toast("Hello world")

    const toastEl = await screen.findByText("Hello world")
    expect(toastEl).toBeInTheDocument()
  })

  // 3.2
  it("[tag:toast][tag:rendering] should display a toast with a description", async () => {
    renderToaster()
    toast("Title text", { description: "Description text" })

    const title = await screen.findByText("Title text")
    const description = await screen.findByText("Description text")
    expect(title).toBeInTheDocument()
    expect(description).toBeInTheDocument()
  })

  // 4 — Toast variants

  // 4.1
  it("[tag:toast][tag:success] should render a success toast with the success class", async () => {
    renderToaster()
    toast.success("Operation succeeded")

    const toastEl = await screen.findByText("Operation succeeded")
    const toastContainer = toastEl.closest("[data-sonner-toast]")
    expect(toastContainer).toHaveAttribute("data-type", "success")
  })

  // 4.2
  it("[tag:toast][tag:error] should render an error toast with the error class", async () => {
    renderToaster()
    toast.error("Something went wrong")

    const toastEl = await screen.findByText("Something went wrong")
    const toastContainer = toastEl.closest("[data-sonner-toast]")
    expect(toastContainer).toHaveAttribute("data-type", "error")
  })

  // 4.3
  it("[tag:toast][tag:warning] should render a warning toast", async () => {
    renderToaster()
    toast.warning("Careful now")

    const toastEl = await screen.findByText("Careful now")
    const toastContainer = toastEl.closest("[data-sonner-toast]")
    expect(toastContainer).toHaveAttribute("data-type", "warning")
  })

  // 4.4
  it("[tag:toast][tag:info] should render an info toast", async () => {
    renderToaster()
    toast.info("For your information")

    const toastEl = await screen.findByText("For your information")
    const toastContainer = toastEl.closest("[data-sonner-toast]")
    expect(toastContainer).toHaveAttribute("data-type", "info")
  })

  // 5 — Action button

  // 5.1
  it("[tag:toast][tag:action] should render a toast with an action button and fire the callback", async () => {
    const user = userEvent.setup()
    const handleAction = vi.fn()
    renderToaster()

    toast("Undo changes?", {
      action: { label: "Undo", onClick: handleAction },
    })

    const actionButton = await screen.findByText("Undo")
    expect(actionButton).toBeInTheDocument()
    await user.click(actionButton)
    expect(handleAction).toHaveBeenCalledOnce()
  })

  // 6 — Dismiss

  // 6.1
  it("[tag:toast][tag:dismiss] should dismiss a toast programmatically", async () => {
    renderToaster()
    const id = toast("Temporary toast")

    await screen.findByText("Temporary toast")
    toast.dismiss(id)

    await waitFor(() => {
      expect(screen.queryByText("Temporary toast")).not.toBeInTheDocument()
    })
  })
})
