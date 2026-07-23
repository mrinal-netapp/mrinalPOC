import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@test/render"

import { EditConfigDialog } from "./edit-config-dialog"

const baseFields = [
  { key: "serverUrl", label: "Server URL", value: "https://example.com", isRequired: true },
]

describe("EditConfigDialog", () => {
  it("[tag:edit-config-dialog] calls onSave when required fields are valid", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderWithProviders(
      <EditConfigDialog
        open
        fields={baseFields}
        onFieldChange={vi.fn()}
        addCustomHeaders={false}
        customHeaders={[]}
        onCustomHeadersToggle={vi.fn()}
        onCustomHeaderValuesChange={vi.fn()}
        addForwardedHeaders={false}
        forwardedHeaders={[]}
        onForwardedHeadersToggle={vi.fn()}
        onForwardedHeaderValuesChange={vi.fn()}
        applyRateLimiting={false}
        callsPerMinute=""
        onRateLimitingToggle={vi.fn()}
        onCallsPerMinuteChange={vi.fn()}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:edit-config-dialog] blocks save when required field is empty", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderWithProviders(
      <EditConfigDialog
        open
        fields={[{ key: "serverUrl", label: "Server URL", value: "", isRequired: true }]}
        onFieldChange={vi.fn()}
        addCustomHeaders={false}
        customHeaders={[]}
        onCustomHeadersToggle={vi.fn()}
        onCustomHeaderValuesChange={vi.fn()}
        addForwardedHeaders={false}
        forwardedHeaders={[]}
        onForwardedHeadersToggle={vi.fn()}
        onForwardedHeaderValuesChange={vi.fn()}
        applyRateLimiting={false}
        callsPerMinute=""
        onRateLimitingToggle={vi.fn()}
        onCallsPerMinuteChange={vi.fn()}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:edit-config-dialog] renders helper text and custom headers flow", async () => {
    const onCustomHeaderValuesChange = vi.fn()
    const onCustomHeadersToggle = vi.fn()
    const onRateLimitingToggle = vi.fn()
    const onCallsPerMinuteChange = vi.fn()
    const onFieldChange = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderWithProviders(
      <EditConfigDialog
        open
        fields={[
          {
            key: "serverUrl",
            label: "Server URL",
            value: "https://example.com",
            isRequired: false,
            helperText: "Helper for server URL",
          },
        ]}
        onFieldChange={onFieldChange}
        addCustomHeaders
        customHeaders={[{ key: "k1", value: "v1" }]}
        onCustomHeadersToggle={onCustomHeadersToggle}
        onCustomHeaderValuesChange={onCustomHeaderValuesChange}
        addForwardedHeaders={false}
        forwardedHeaders={[]}
        onForwardedHeadersToggle={vi.fn()}
        onForwardedHeaderValuesChange={vi.fn()}
        applyRateLimiting
        callsPerMinute="60"
        onRateLimitingToggle={onRateLimitingToggle}
        onCallsPerMinuteChange={onCallsPerMinuteChange}
        onSave={vi.fn()}
        onClose={onClose}
      />,
    )

    expect(screen.getByText("Helper for server URL")).toBeInTheDocument()

    await user.click(screen.getByLabelText("Add custom headers"))
    await user.click(screen.getByRole("button", { name: "Delete header" }))
    expect(onCustomHeaderValuesChange).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Add custom header" }))
    await user.click(screen.getByLabelText("Apply rate limiting"))
    await user.clear(screen.getByLabelText("Calls per minute"))
    await user.type(screen.getByLabelText("Calls per minute"), "90")

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:edit-config-dialog] calls onFieldChange when editing a field", async () => {
    const onFieldChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderWithProviders(
      <EditConfigDialog
        open
        fields={baseFields}
        onFieldChange={onFieldChange}
        addCustomHeaders
        customHeaders={[{ key: "k1", value: "v1" }]}
        onCustomHeadersToggle={vi.fn()}
        onCustomHeaderValuesChange={vi.fn()}
        addForwardedHeaders={false}
        forwardedHeaders={[]}
        onForwardedHeadersToggle={vi.fn()}
        onForwardedHeaderValuesChange={vi.fn()}
        applyRateLimiting={false}
        callsPerMinute=""
        onRateLimitingToggle={vi.fn()}
        onCallsPerMinuteChange={vi.fn()}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    await user.clear(screen.getByLabelText("Server URL *"))
    await user.type(screen.getByLabelText("Server URL *"), "https://updated.example.com")
    expect(onFieldChange).toHaveBeenCalledWith("serverUrl", expect.any(String))

    await user.clear(screen.getByLabelText("Header key"))
    await user.type(screen.getByLabelText("Header key"), "Authorization")
    await user.clear(screen.getByLabelText("Header value"))
    await user.type(screen.getByLabelText("Header value"), "updated")
  })

  it("[tag:edit-config-dialog] closes via escape", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderWithProviders(
      <EditConfigDialog
        open
        fields={baseFields}
        onFieldChange={vi.fn()}
        addCustomHeaders={false}
        customHeaders={[]}
        onCustomHeadersToggle={vi.fn()}
        onCustomHeaderValuesChange={vi.fn()}
        addForwardedHeaders={false}
        forwardedHeaders={[]}
        onForwardedHeadersToggle={vi.fn()}
        onForwardedHeaderValuesChange={vi.fn()}
        applyRateLimiting={false}
        callsPerMinute=""
        onRateLimitingToggle={vi.fn()}
        onCallsPerMinuteChange={vi.fn()}
        onSave={vi.fn()}
        onClose={onClose}
      />,
    )

    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })
})
