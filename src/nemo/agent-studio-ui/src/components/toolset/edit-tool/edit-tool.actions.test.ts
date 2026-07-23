import { act, renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { describe, expect, it } from "vitest"

import { createMockStore } from "@test/mocks"

import { loadEditToolForm, resetEditToolState } from "../reducer"
import type { EditToolLoadPayload } from "../toolset.types"
import { useEditToolFormState } from "./edit-tool.actions"

const editPayload: EditToolLoadPayload = {
  name: "tool-mcp-01",
  description: "description",
  labels: ["staging"],
  addCustomHeaders: false,
  customHeaders: [],
  addForwardedHeaders: false,
  forwardedHeaders: [""],
  applyRateLimiting: false,
  callsPerMinute: "",
  configFields: [
    { key: "serverUrl", label: "Server URL", value: "", isRequired: true },
    { key: "scope", label: "Scope", value: "read", isRequired: false },
  ],
}

describe("useEditToolFormState", () => {
  const renderEditHook = () => {
    const store = createMockStore()
    store.dispatch(resetEditToolState())
    store.dispatch(loadEditToolForm({ toolId: "tool-mcp-01", ...editPayload }))

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    return { store, ...renderHook(() => useEditToolFormState(), { wrapper }) }
  }

  it("[tag:edit-tool-state] exposes loaded form state from redux", () => {
    const { result } = renderEditHook()
    expect(result.current.toolId).toBe("tool-mcp-01")
    expect(result.current.name).toBe("tool-mcp-01")
    expect(result.current.requiredConfigMissing).toBe(true)
  })

  it("[tag:edit-tool-state] updates description and config field values", () => {
    const { result } = renderEditHook()

    act(() => {
      result.current.setDescription("updated")
      result.current.setConfigFieldValue("serverUrl", "https://example.com")
    })

    expect(result.current.description).toBe("updated")
    expect(result.current.requiredConfigMissing).toBe(false)
  })

  it("[tag:edit-tool-state] updates labels and opens config dialog", () => {
    const { result } = renderEditHook()

    act(() => {
      result.current.onLabelChange(["staging", "production"])
      result.current.openConfigDialog()
    })

    expect(result.current.selectedLabels).toEqual(["staging", "production"])
    expect(result.current.configDialogOpen).toBe(true)
  })

  it("[tag:edit-tool-state] covers remaining hook actions", () => {
    const { result } = renderEditHook()

    act(() => {
      result.current.onLabelChange("production")
      result.current.onAddLabel("Team-C")
      result.current.closeConfigDialog()
      result.current.setAddCustomHeaders(true)
      result.current.setCustomHeaders([{ key: "h", value: "v" }])
      result.current.setApplyRateLimiting(true)
      result.current.setCallsPerMinute("120")
      result.current.setSubmitted(true)
    })

    expect(result.current.selectedLabels).toContain("production")
    expect(result.current.selectedLabels).toContain("team-c")
    expect(result.current.configDialogOpen).toBe(false)
    expect(result.current.submitted).toBe(true)
  })
})
