import { fireEvent, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, useTestForm, userEvent } from "@test/render"

import { Form } from "@/ui-lib/base-components/form"
import { UploadDropzone } from "./upload-dropzone"

function TestHarness(): ReactElement {
  const form = useTestForm({ uploaded_files: [] as File[] })
  return (
    <Form form={form}>
      <UploadDropzone form={form} />
    </Form>
  )
}

describe("UploadDropzone", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("invokes the hidden file input when clicking Upload files", async () => {
    const user = userEvent.setup()
    const clickSpy = vi.fn()
    const { container } = renderWithProviders(<TestHarness />)
    const input = container.querySelector<HTMLInputElement>(".dset-form__upload-input")
    if (input) {
      input.addEventListener("click", clickSpy, { once: true })
    }

    await user.click(screen.getByRole("button", { name: "Upload files" }))

    expect(clickSpy).toHaveBeenCalled()
  })

  it("appends files from onChange and shows names; remove clears a file", async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<TestHarness />)
    const input = container.querySelector<HTMLInputElement>(".dset-form__upload-input")
    if (!input) {
      throw new Error("file input not found")
    }

    const f1 = new File([""], "a.pdf", { type: "application/pdf" })
    const f2 = new File([""], "b.txt", { type: "text/plain" })
    await user.upload(input, [f1, f2])

    expect(screen.getByText("a.pdf")).toBeInTheDocument()
    expect(screen.getByText("b.txt")).toBeInTheDocument()

    // Files are validated synchronously on add and get status "ready" immediately.
    await user.click(screen.getByRole("button", { name: "Remove a.pdf" }))
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument()
    expect(screen.getByText("b.txt")).toBeInTheDocument()
  })

  it("ignores a null FileList in onChange (merge guard)", () => {
    const { container } = renderWithProviders(<TestHarness />)
    const input = container.querySelector<HTMLInputElement>(".dset-form__upload-input")
    if (!input) {
      throw new Error("file input not found")
    }
    expect(() => {
      fireEvent.change(input, { target: { files: null } })
    }).not.toThrow()
  })

  it("treats missing uploaded_files in store as an empty file list", () => {
    function NoUploadField(): ReactElement {
      const form = useTestForm({} as Record<string, unknown>)
      return (
        <Form form={form as never}>
          <UploadDropzone form={form} />
        </Form>
      )
    }
    renderWithProviders(<NoUploadField />)
    expect(screen.getByRole("button", { name: "Upload files" })).toBeInTheDocument()
    // No file rows when the field is absent from default values
    const list = document.querySelector(".dset-form__upload-list")
    expect(list).not.toBeInTheDocument()
  })
})
